const EventEmitter = require('events');
const chokidar = require("chokidar");
const fs = require("fs-extra");

class LocalWatcher extends EventEmitter {
  constructor(syncObject) {
    super();

    this.sync = syncObject;

    this.ready = false;
    this.cache = {};
    this.localQueue = [];
    this.initialized = false;
    this.autoSyncInterval = null;
  }

  get folder() {
    return this.sync.folder;
  }

  get lastOnline() {
    return this.sync.account.previousSaveTime;
  }

  init() {
    if (!this.initialized) {
      this.startWatching();
      
      this.autoSyncInterval = setInterval(() => {
        if (this.sync && !this.sync.syncing) {
          this.sync.autoSyncNewFiles();
        }
      }, 30000);
      
      this.initialized = true;
    }
  }

  async startWatching() {
    if (await fs.exists(this.sync.folder)) {
      if (!this.sync.paths) {
        this.sync.paths = {};
      }
      
      let paths = Object.keys(this.sync.paths);

      paths.sort();

      for (let path of paths) {
        let fileInfo = this.sync.fileInfoFromPath(path);

        if (!fileInfo || this.sync.shouldIgnoreFile(fileInfo)) {
          continue;
        }

        if (this.sync.locallyRegistered(path) && !await fs.exists(path)) {
          this.sync.unregisterLocalFile(path);
          this.addCache(path, 'unlink');
          console.log(`${path} not detected locally, scheduling for unlink`);
        }
      }
    }

    this.watcher = chokidar.watch(this.folder, {
      ignored: /(^|[/\\])\..*(\.tmp$)/,
      persistent: true
    });

    this.watcher.on('add', path => this.queue(path, 'add'))
      .on('change', (path, stats) => this.queue(path, 'change', stats))
      .on('unlink', path => this.queue(path, 'unlink'))
      .on('addDir', path => this.queue(path, 'addDir'))
      .on('unlinkDir', path => this.queue(path, 'unlinkDir'))
      .on('ready', () => this.queue('', 'ready'))
      .on('error', error => console.log(`Watcher error: ${error}`));
  }

  stopWatching() {
    this.closed = true;
    if (this.watcher) {
      this.watcher.close();
    }
    if (this.autoSyncInterval) {
      clearInterval(this.autoSyncInterval);
    }
  }

  async queue(path, event) {
    this.localQueue.push([event, path]);

    if (this.localQueue.length > 1) {
      return;
    }

    while (this.localQueue.length > 0 && !this.closed) {
      await this.dealWithQueuedEvent(this.localQueue[0]);
      this.localQueue.shift();
    }
  }

  async dealWithQueuedEvent([event, path]) {
    if (event == "ready") {
      this.ready = true;
      console.log('Initial scan complete. Ready for changes');
      return;
    }

    if (path == this.sync.folder && event == "addDir") {
      return;
    }

    if (event == "add" || event == "addDir") {
      this.sync.registerLocalFile(path);
    } else if (event == "unlink" || event == "unlinkDir") {
      this.sync.unregisterLocalFile(path);
    }

    if (!this.ready) {
      if (path in this.sync.paths) {
        let {mtime} = await fs.stat(path);
        mtime = (new Date(mtime)).getTime();

        if (this.lastOnline - mtime > 0) {
          return;
        } else {
          console.log(`Modified since last launch: ${path}`);
        }
      } else {
        console.log(`New file since launch: ${path}`);
      }
    }

    this.addCache(path, event);
  }

  createCache(path) {
    this.cache[path] = {
      timer: 0,
      events: []
    };
  }

  clearCache(path) {
    delete this.cache[path];
  }

  addCache(path, event) {
    if (! (path in this.cache)) {
      this.createCache(path);
    }

    let cache = this.cache[path];
    clearTimeout(cache.timer);
    cache.events.push(event);
    cache.timer = setTimeout(() => this.analyzeCache(path), 1000);
  }

  analyzeCache(path) {
    let cache = this.cache[path];

    if (!cache || cache.events.includes("ignore")) {
      console.log("ignoring events for path", path);
      return this.clearCache(path);
    }

    let events = cache.events;

    let lastIndex = Math.max(
      events.lastIndexOf('unlink'), 
      events.lastIndexOf('unlinkDir'), 
      events.lastIndexOf('add'), 
      events.lastIndexOf('addDir')
    );
    
    if (lastIndex != -1) {
      console.log("Emitting last important event for", path, events[lastIndex]);
      this.emit(events[lastIndex], path);
    } else {
      console.log("Emitting last event for", path);
      this.emit(events.pop(), path);
    }

    this.clearCache(path);
  }

  ignore(path) {
    this.addCache(path, "ignore");
  }
}

module.exports = LocalWatcher;