let globalKeys = {}

class ShardedIntervalQueue {
  async isSet(key) {
    return (`${this.queueName}_${key}` in globalKeys);
  }

  async increment(key) {
    let val = globalKeys[`${this.queueName}_${key}`];
    globalKeys[`${this.queueName}_${key}`] = val+1;
    return val;
  }

  async setAsync(key, value) {
    globalKeys[`${this.queueName}_${key}`] = value;
  }

  async getAsync(key) {
    return globalKeys[`${this.queueName}_${key}`];
  }

  async initStorage() {
    globalKeys = {};
  }

  setStorageLowDB(db, skipInit) {
    if(!skipInit) {
      let dbDefaults = {}
      dbDefaults[this.queueName] = {};
      this.initStorage = async () => await db.defaults(dbDefaults);
    } else {
      this.initStorage = async () => null;
    }

    this.getAsync = async key => await db.get(this.queueName).get(key).value();
    this.isSet = async key => await db.get(this.queueName).has(key).value();
    this.setAsync = async (key, value) => (await db.set(`${this.queueName}.${key}`, value).write())[this.queueName][key];
    this.increment = async (key) => (await db.get(this.queueName).update(key, n=>n+1).write())[key]-1;
  }

  setStorageCustom(initStorage, isSet, getAsync, setAsync, incrementAsync) {
    this.initStorage = initStorage;
    this.isSet = isSet;
    this.getAsync = getAsync;
    this.setAsync = setAsync;
    this.increment = incrementAsync;
  }

  setStorageRedis(client) {
    const { promisify } = require('util');
    let redisGet = promisify(client.get).bind(client);
    let redisSet = promisify(client.set).bind(client);
    let redisEval = promisify(client.eval).bind(client);

    this.initStorage = async () => null;
    this.getAsync = async key => await redisGet(`${this.queueName}_${key}`);
    this.setAsync = async (key, value) => await redisSet(`${this.queueName}_${key}`, value);
    this.isSet = async key => (await redisGet(`${this.queueName}_${key}`)) !== null;
    this.increment = async (key) => {
      const lua = `
                local p = redis.call('incr', KEYS[1])
                return p`;
      return await redisEval(lua, 1, `${this.queueName}_${key}`);
    }
  }

  async init(intervalMs, reset, failIfExists) {
    await this.initStorage;
    if(!(await this.isSet('ticket')) || reset) {
      this.setAsync('ticket', 1);
      this.setAsync('current', 0);
      this.setAsync('interval', intervalMs);
      this.setAsync('paused', false);
    } else {
      if(failIfExists)
        throw new Error("Queue exists");
    }
  }

  constructor(queueName) {
    this.queueName = queueName;

    this.queue = [];
    this.index = 0;
    this.job = null;
  }

  async add(asyncFunction, doNotStart) {
    let queueNo = await this.increment('ticket');
    let myPromise = new Promise((resolve, reject) => {
      this.queue.push({
        queueNo,
        task: () => {
          asyncFunction().then(value => resolve(value)).catch(err => reject(err));
        }
      });
    });
    if(!doNotStart && !this.job) {
      await this.start(true);
    }
    return myPromise;
  }

  decorator(asyncFunction, doNotStart) {
    let thisQueue = this;
    return function () {
      return thisQueue.add(() => asyncFunction.apply(this, arguments), doNotStart);
    }
  }

  runNext() {
    let thisQueue = this;
    return () => {
      Promise.all([thisQueue.getAsync('paused'), thisQueue.getAsync('current'), thisQueue.getAsync('interval')])
        .then(([paused, current, interval]) => {
          current = parseInt(current);
          interval = parseInt(interval);
          if(typeof paused === "string")
            paused = (paused === "true");
          if(paused || thisQueue.index >= thisQueue.queue.length) {
            this.job = null;
            return;
          }

          thisQueue.index = thisQueue.index+1;
          let currentIndex = thisQueue.index;

          if(thisQueue.queue[currentIndex-1].queueNo < current) {
            thisQueue.increment('ticket').then(queueNo => {
              queueNo = parseInt(queueNo);
              thisQueue.queue.push({
                queueNo,
                task: thisQueue.queue[currentIndex-1].task
              });
              thisQueue.runNext()();
            });
          }

          if(currentIndex < thisQueue.queue.length) {
            thisQueue.job = setTimeout(
              thisQueue.runNext(),
              (thisQueue.queue[currentIndex].queueNo-current-1)*interval);
          } else {
            thisQueue.job = null;
          }
          thisQueue.setAsync('current', thisQueue.queue[currentIndex-1].queueNo).then(() => {
            thisQueue.queue[currentIndex-1].task();
          });
        });
    }
  }

  async pause() {
    await this.setAsync('paused', true);

    this.job = null;
  }

  async unpause() {
    await this.setAsync('paused', false);

    if(!this.job && this.index < this.queue.length)
      this.start(true);
   }

  start(silent) {
    if(this.job) {
      if(!silent)
        throw new Error("Queue has already started");
      else
        return;
    }
    if(this.index >= this.queue.length) {
      if(!silent)
        throw new Error("Queue empty");
      else
        return;
    }
    Promise.all([this.getAsync('paused'), this.getAsync('current'), this.getAsync('interval')]).then(([paused, current, interval]) => {
      if(typeof paused === "string")
        paused = (paused === "true");
      current = parseInt(current);
      interval = parseInt(interval);
      if(paused) {
        this.job = null;
        if(!silent) {
          throw new Error("Queue paused");
        }
        else {
          return;
        }
      }
      if(this.job) {
        return;
      }
      this.job = setTimeout(this.runNext(), (this.queue[this.index].queueNo-current)*interval);
    })
  }
}

module.exports = ShardedIntervalQueue;