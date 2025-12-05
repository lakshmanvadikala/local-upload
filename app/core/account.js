const path = require('path');
const os = require('os');
const EventEmitter = require('events');
const { net } = require('electron');
const globals = require('../../config/globals');

const toSave = ["email", "tokens", "folder", "saveTime", "syncedFiles"];

class Account extends EventEmitter {
  constructor(doc) {
    super();

    if (doc) {
      this.load(doc);
      this.previousSaveTime = doc.saveTime || Date.now();
    }

    this.folder = this.folder || 'Select Target Folder to Upload Resumes';
    this.syncedFiles = this.syncedFiles || {};

    this.api = {
      baseUrl: 'https://qa.engazewell.com/api',
      token: null,
      tokenExpiry: null
    };

    if (this.tokens && this.tokens.access) {
      this.api.token = this.tokens.access.token;
      this.api.tokenExpiry = new Date(this.tokens.access.expires);
    }
  }

  /* ---------- helpers ---------- */

  normalizePath(filePath) {
    if (!filePath) return filePath;
    // normalize + lowercase so DB + runtime always match
    return path.resolve(filePath).toLowerCase();
  }

  get running() {
    return !!(this.sync && this.sync.running);
  }

  get syncing() {
    return this.sync ? this.sync.syncing : false;
  }

  get authUrl() {
    return '/auth/login';
  }

  /* ---------- auth & api ---------- */

  async login(email, password) {
    console.log("Logging in with credentials");

    return new Promise((resolve, reject) => {
      const request = net.request({
        method: 'POST',
        protocol: 'https:',
        hostname: 'qa.engazewell.com',
        path: '/api/auth/login',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      });

      request.on('response', (response) => {
        let data = '';
        response.on('data', (chunk) => { data += chunk; });

        response.on('end', async () => {
          if (response.statusCode !== 200) {
            reject(new Error(`Login failed: ${response.statusCode}`));
            return;
          }

          try {
            const result = JSON.parse(data);

            this.tokens = result.tokens;
            this.email = result.user.emailAddress;
            this.api.token = result.tokens.access.token;
            this.api.tokenExpiry = new Date(result.tokens.access.expires);

            await this.save();
            resolve(result);
          } catch (error) {
            reject(error);
          }
        });
      });

      request.on('error', (error) => reject(error));

      request.write(JSON.stringify({
        emailAddress: email,
        password: password
      }));

      request.end();
    });
  }

  async ensureToken() {
    if (!this.api.token || new Date() >= this.api.tokenExpiry - 60000) {
      console.log("Token expired or about to expire, refreshing...");
      throw new Error("Token expired. Please login again.");
    }
    return this.api.token;
  }

  async apiRequest(endpoint, options = {}) {
    try {
      const token = await this.ensureToken();

      const defaultHeaders = {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
        ...options.headers
      };

      const FormData = require('form-data');

      if (options.body && options.body instanceof FormData) {
        delete defaultHeaders['Content-Type'];
        const formHeaders = options.body.getHeaders();
        Object.assign(defaultHeaders, formHeaders);
      } else if (!defaultHeaders['Content-Type']) {
        defaultHeaders['Content-Type'] = 'application/json';
      }

      return new Promise((resolve, reject) => {
        const request = net.request({
          method: options.method || 'GET',
          protocol: 'https:',
          hostname: 'qa.engazewell.com',
          path: `/api${endpoint}`,
          headers: defaultHeaders
        });

        request.on('response', (response) => {
          let data = '';
          response.on('data', (chunk) => { data += chunk; });

          response.on('end', () => {
            if (response.statusCode === 401 || response.statusCode === 403) {
              console.log("Token invalid, attempting re-login...");
              this.api.token = null;
              reject(new Error("Token expired, please login again"));
              return;
            }

            if (response.statusCode < 200 || response.statusCode >= 300) {
              reject(new Error(`API request failed: ${response.statusCode} ${data}`));
              return;
            }

            try {
              const jsonData = JSON.parse(data);
              resolve({
                json: () => Promise.resolve(jsonData),
                text: () => Promise.resolve(data),
                status: response.statusCode,
                ok: response.statusCode >= 200 && response.statusCode < 300
              });
            } catch (error) {
              resolve({
                json: () => Promise.reject(new Error('Not JSON')),
                text: () => Promise.resolve(data),
                status: response.statusCode,
                ok: response.statusCode >= 200 && response.statusCode < 300
              });
            }
          });
        });

        request.on('error', (error) => reject(error));

        if (options.body) {
          if (options.body instanceof FormData) {
            options.body.pipe(request);
          } else {
            request.write(typeof options.body === 'string'
              ? options.body
              : JSON.stringify(options.body));
            request.end();
          }
        } else {
          request.end();
        }
      });
    } catch (error) {
      if (error.message.includes("Token expired")) {
        this.emit('tokenExpired');
      }
      throw error;
    }
  }

  /* ---------- persistence ---------- */

  async save() {
    console.log("Saving account to db");
    this.saveTime = Date.now();
    let doc = this.document || {};

    for (let element of toSave) {
      if (element in this) {
        if (element === 'syncedFiles') {
          const syncedArray = [];
          for (const [storedKey, fileInfo] of Object.entries(this.syncedFiles)) {
            // store friendly path for display; keep original if available
            const filePath = fileInfo.originalPath || storedKey;
            const { originalPath, ...rest } = fileInfo;
            syncedArray.push({
              filePath,
              ...rest
            });
          }
          doc[element] = syncedArray;
        } else {
          doc[element] = this[element];
        }
      }
    }

    if (this.document) {
      await globals.db.update({ _id: doc._id }, doc, {});
    } else {
      doc.type = "account";
      this.document = await globals.db.insert(doc);
      this.id = this.document._id;
    }

    console.log("Saved account!");
  }

  load(doc) {
    this.document = doc;

    for (let element of toSave) {
      if (!(element in doc)) continue;

      if (element === 'syncedFiles') {
        this.syncedFiles = {};

        // CASE 1: stored as array [{ filePath, ... }]
        if (Array.isArray(doc.syncedFiles)) {
          for (const item of doc.syncedFiles) {
            const { filePath, ...fileInfo } = item;
            const key = this.normalizePath(filePath);
            this.syncedFiles[key] = {
              ...fileInfo,
              originalPath: filePath
            };
          }
        }
        // CASE 2: legacy: stored as object map
        else if (typeof doc.syncedFiles === 'object' && doc.syncedFiles !== null) {
          for (const [filePath, fileInfo] of Object.entries(doc.syncedFiles)) {
            const key = this.normalizePath(filePath);
            this.syncedFiles[key] = {
              ...fileInfo,
              originalPath: fileInfo.originalPath || filePath
            };
          }
        }
      } else {
        this[element] = doc[element];
      }
    }

    this.id = doc._id;
  }

  async erase() {
    console.log("Removing account from db");
    if (this.sync) {
      await this.sync.erase();
      this.sync = null;
      globals.updateSyncing(false);
    }
    if (this.id) {
      await globals.db.remove({ _id: this.id });
    }
  }

  async finishLoading() {
    if (this.sync) {
      await this.sync.finishLoading();
    }
  }

  /* ---------- synced files helpers ---------- */

  trackSyncedFile(filePath, fileInfo) {
    const normalized = this.normalizePath(filePath);

    this.syncedFiles[normalized] = {
      id: fileInfo.id || `${path.basename(filePath)}_${Date.now()}`,
      uploadedAt: Date.now(),
      fileSize: require('fs-extra').statSync(filePath).size,
      cv_url: fileInfo.cv_url,
      transactionId: fileInfo.transactionId,
      originalPath: filePath
    };
  }

  isFileSynced(filePath) {
    const normalized = this.normalizePath(filePath);
    return !!(normalized && this.syncedFiles && this.syncedFiles[normalized]);
  }

  getFileInfo(filePath) {
    const normalized = this.normalizePath(filePath);
    return this.syncedFiles ? this.syncedFiles[normalized] : undefined;
  }
}

module.exports = Account;
