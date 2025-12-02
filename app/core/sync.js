const path = require("path");
const fs = require("fs-extra");
const mkdirp = require("mkdirp-promise");
const EventEmitter = require('events');
const FormData = require('form-data');
const crypto = require('crypto');
const globals = require('../../config/globals');
const LocalWatcher = require('./localwatcher');

class Sync extends EventEmitter {
  constructor(account) {
    super();

    this.account = account;
    this.fileInfo = {};
    this.paths = {};
    this.queued = [];
    this.loaded = false;
    this.closed = false;
    this.savedTime = 0;
    this.currentSyncProgress = {
      totalFiles: 0,
      processedFiles: 0,
      currentFile: null,
      status: 'idle'
    };

    this.watcher = new LocalWatcher(this);
    this.initWatcher();

    this.load();
  }

  set syncing(value) {
    if (this.syncing === value) return;
    this._syncing = value;
    this.currentSyncProgress.status = value ? 'syncing' : 'idle';
    this.emit("syncing", value);
    this.emit("progress", this.currentSyncProgress);
  }

  get syncing() {
    return this._syncing;
  }

  get folder() {
    return this.account.folder;
  }

  get running() {
    return "id" in this;
  }

  async uploadFile(filePath) {
    console.log(`🚀 Uploading file: ${filePath}`);
    
    if (this.account.isFileSynced(filePath)) {
      console.log(`✅ File already synced: ${filePath}`);
      return { skipped: true, filePath };
    }

    if (!await fs.exists(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const stats = await fs.stat(filePath);
    if (!stats.isFile()) {
      console.log(`⏭️ Skipping non-file: ${filePath}`);
      return { skipped: true, filePath };
    }

    this.currentSyncProgress.currentFile = path.basename(filePath);
    this.emit("progress", this.currentSyncProgress);

    const formData = new FormData();
    formData.append(
      "resumefiles",
      fs.createReadStream(filePath),
      {
        filename: path.basename(filePath),
        contentType: this.getMimeType(filePath)
      }
    );

    try {
      console.log(`📤 Calling API for: ${path.basename(filePath)}`);
      
      const response = await this.account.apiRequest('/resumes/profileupload?filesCount=1', {
        method: 'POST',
        body: formData
      });

      const result = await response.json();
      console.log(`✅ API response for ${path.basename(filePath)}:`, result);

      if (result && result[0]) {
        this.account.trackSyncedFile(filePath, result[0]);
      }

      this.currentSyncProgress.processedFiles++;
      this.emit("progress", this.currentSyncProgress);

      await this.account.save();

      return { success: true, filePath, result };
    } catch (error) {
      console.error(`❌ Failed to upload ${filePath}:`, error.message);
      return { success: false, filePath, error: error.message };
    }
  }

  getMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.pdf': 'application/pdf',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.txt': 'text/plain',
      '.zip': 'application/zip'
    };
    return mimeTypes[ext] || 'application/octet-stream';
  }

  async scanFolder(folderPath) {
    console.log(`📁 Scanning folder: ${folderPath}`);
    
    if (!await fs.exists(folderPath)) {
      throw new Error(`Folder does not exist: ${folderPath}`);
    }

    const files = [];
    
    async function scan(dir) {
      const items = await fs.readdir(dir);
      
      for (const item of items) {
        const fullPath = path.join(dir, item);
        const stats = await fs.stat(fullPath);
        
        if (stats.isFile()) {
          files.push(fullPath);
        } else if (stats.isDirectory()) {
          await scan(fullPath);
        }
      }
    }
    
    await scan(folderPath);
    return files;
  }

  async start(notifyCallback) {
    if (this.syncing) {
      throw new Error("Sync already in progress");
    }

    this.syncing = true;
    console.log("🔄 Starting synchronization...");

    try {
      const notify = notifyCallback || ((msg) => console.log(msg));
      
      notify("Scanning folder for files...");
      
      const allFiles = await this.scanFolder(this.folder);
      console.log(`📊 Found ${allFiles.length} files to process`);
      
      this.currentSyncProgress = {
        totalFiles: allFiles.length,
        processedFiles: 0,
        currentFile: null,
        status: 'syncing'
      };
      this.emit("progress", this.currentSyncProgress);

      const filesToUpload = allFiles.filter(file => !this.account.isFileSynced(file));
      console.log(`📤 ${filesToUpload.length} new files to upload`);
      
      notify(`Found ${allFiles.length} files, ${filesToUpload.length} new to upload`);

      let uploadedCount = 0;
      let skippedCount = 0;
      let failedCount = 0;

      for (let i = 0; i < filesToUpload.length; i++) {
        const file = filesToUpload[i];
        const result = await this.uploadFile(file);
        
        if (result.skipped) skippedCount++;
        else if (result.success) uploadedCount++;
        else failedCount++;

        const processed = uploadedCount + skippedCount + failedCount;
        notify(`Progress: ${processed}/${filesToUpload.length} files (${uploadedCount} uploaded, ${skippedCount} skipped, ${failedCount} failed)`);
        
        if (i < filesToUpload.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      const summary = `✅ Sync completed! Uploaded: ${uploadedCount}, Skipped: ${skippedCount}, Failed: ${failedCount}`;
      notify(summary);
      
      try {
        if (this.watcher && this.folder) {
          await this.watcher.startWatching();
        }
      } catch (error) {
        console.error("Error starting file watcher:", error);
      }
      
      this.syncing = false;
      this.currentSyncProgress.status = 'completed';
      this.emit("progress", this.currentSyncProgress);
      
      return { uploadedCount, skippedCount, failedCount, summary };
    } catch (error) {
      console.error("❌ Sync failed:", error);
      this.syncing = false;
      this.currentSyncProgress.status = 'error';
      this.emit("progress", this.currentSyncProgress);
      throw error;
    }
  }

  async autoSyncNewFiles() {
    if (this.syncing || !this.account.folder) {
      return;
    }

    try {
      console.log("🔍 Auto-scanning for new files...");
      
      const allFiles = await this.scanFolder(this.folder);
      const filesToUpload = allFiles.filter(file => !this.account.isFileSynced(file));
      
      if (filesToUpload.length > 0) {
        console.log(`🔄 Auto-sync: Found ${filesToUpload.length} new files`);
        await this.startAutoSync(filesToUpload);
      }
    } catch (error) {
      console.error("Auto-sync error:", error);
    }
  }

  async startAutoSync(filesToUpload) {
    this.syncing = true;
    this.currentSyncProgress = {
      totalFiles: filesToUpload.length,
      processedFiles: 0,
      currentFile: null,
      status: 'auto-syncing'
    };
    this.emit("progress", this.currentSyncProgress);

    let uploadedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    for (let i = 0; i < filesToUpload.length; i++) {
      const file = filesToUpload[i];
      const result = await this.uploadFile(file);
      
      if (result.skipped) skippedCount++;
      else if (result.success) uploadedCount++;
      else failedCount++;

      this.currentSyncProgress.processedFiles = uploadedCount + skippedCount + failedCount;
      this.emit("progress", this.currentSyncProgress);
      
      if (i < filesToUpload.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    this.syncing = false;
    this.currentSyncProgress.status = 'completed';
    this.emit("progress", this.currentSyncProgress);
    
    console.log(`✅ Auto-sync completed: ${uploadedCount} uploaded, ${skippedCount} skipped, ${failedCount} failed`);
    return { uploadedCount, skippedCount, failedCount };
  }

  fileInfoFromPath(path) {
    if (!this.paths) {
      this.paths = {};
      return null;
    }
    
    if (!(path in this.paths)) {
      return null;
    }
    
    let id = this.paths[path];
    
    if (!this.fileInfo || !(id in this.fileInfo)) {
      return null;
    }
    
    return this.fileInfo[id];
  }

  async onLocalFileAdded(filePath) {
    console.log(`📝 New file detected: ${filePath}`);
    
    if (this.account.isFileSynced(filePath)) {
      console.log(`✅ File already synced, ignoring: ${filePath}`);
      return;
    }

    try {
      const result = await this.uploadFile(filePath);
      if (result.success) {
        this.emit("fileSynced", filePath);
      }
    } catch (error) {
      console.error(`❌ Failed to sync new file: ${error.message}`);
      this.emit("syncError", { filePath, error: error.message });
    }
  }

  async onLocalFileUpdated(filePath) {
    console.log(`✏️ File updated: ${filePath}`);
    
    if (this.account.isFileSynced(filePath)) {
      delete this.account.syncedFiles[filePath];
    }
    await this.onLocalFileAdded(filePath);
  }

  async onLocalFileRemoved(filePath) {
    console.log(`🗑️ File removed: ${filePath}`);
    
    if (this.account.isFileSynced(filePath)) {
      delete this.account.syncedFiles[filePath];
      await this.account.save();
    }
  }

  initWatcher() {
    this.watcher.on('add', path => this.queue(() => this.onLocalFileAdded(path)));
    this.watcher.on('unlink', path => this.queue(() => this.onLocalFileRemoved(path)));
    this.watcher.on('change', path => this.queue(() => this.onLocalFileUpdated(path)));
  }

  async queue(fn) {
    this.queued.push(fn);

    if (this.queued.length > 1) {
      return;
    }

    try {
      while (this.queued.length > 0 && !this.closed) {
        const f = this.queued[0];
        await f();
        this.queued.shift();
      }
    } catch (error) {
      console.error("Queue error:", error);
      this.queued.shift();
    }
  }

  async load() {
    this.loaded = true;
  }

  async save() {
    await this.account.save();
  }

  async close() {
    this.closed = true;
    if (this.watcher) {
      this.watcher.stopWatching();
    }
  }

  async erase() {
    await this.close();
    this.account.syncedFiles = {};
    await this.account.save();
  }
}

module.exports = Sync;