let globalKeys = {};
let verbose = false;

class ShardedIntervalQueue {
  async isSet(key) {
    return (`${this.queueName}_${key}` in globalKeys);
  }

  async increment(key) {
    let val = globalKeys[`${this.queueName}_${key}`];
    globalKeys[`${this.queueName}_${key}`] = val+1;
    return val;
  }

  async decrement(key) {
    let val = globalKeys[`${this.queueName}_${key}`];
    globalKeys[`${this.queueName}_${key}`] = val-1;
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
    this.decrement = async (key) => (await db.get(this.queueName).update(key, n=>n-1).write())[key]+1; // TODO: Investigate this behavior later
  }

  setStorageCustom(initStorage, isSet, getAsync, setAsync, incrementAsync, decrementAsync) {
    if(initStorage)
      this.initStorage = initStorage;
    else
      this.initStorage = async () => null;
    this.isSet = async (key) => isSet(this.queueName, key);
    this.getAsync = async (key) => getAsync(this.queueName, key);
    this.setAsync = async (key, value) => setAsync(this.queueName, key, value);
    if(incrementAsync)
      this.increment = async (key) => incrementAsync(this.queueName, key);
    else
      this.increment = async (key) => {
        await this.setAsync(parseInt(await this.getAsync(key))+1);
        return await this.getAsync(key);
      };

    if(decrementAsync)
      this.decrement = async (key) => decrementAsync(this.queueName, key);
    else
      this.decrement = async (key) => {
        await this.setAsync(parseInt(await this.getAsync(key))-1);
        return await this.getAsync(key);
      };
  }

  setStorageRedis(client) {
    const { promisify, isRegExp } = require('util');
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
    this.decrement = async (key) => {
      const lua = `
                local p = redis.call('decr', KEYS[1])
                return p`;
      return await redisEval(lua, 1, `${this.queueName}_${key}`);
    }
  }

  async init(intervalMs, reset, failIfExists, maxJobs) {
    await this.initStorage;
    if(!(await this.isSet('ticket')) || reset) {
      if(maxJobs) {
        await this.setAsync('maxjobs', maxJobs);
        await this.setAsync('runningjobs', 0);
      } else {
        await this.setAsync('maxjobs', -1);
        await this.setAsync('runningjobs', 0);
      }
      await this.setAsync('ticket', 1);
      await this.setAsync('current', 0);
      await this.setAsync('interval', intervalMs);
      await this.setAsync('paused', false);
      await this.setAsync('overcapacity', false);
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
    this.unpauseTimeout = null;
  }

  async add(asyncFunction, doNotStart) {
    let queueNo = await this.increment('ticket');
    let myPromise = new Promise((resolve, reject) => {
      this.queue.push({
        queueNo,
        task: () => {
          asyncFunction().then(value => resolve(value)).catch(err => reject(err))
                                                      .finally(() => this.decrement('runningjobs'));
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

  async executeTask(index) {
    await this.increment('runningjobs');
    if(verbose)
      await Promise.all([this.getAsync('runningjobs'), this.getAsync('maxjobs')]).then(([rJ, mJ]) => console.log("##################New job! Currently running jobs - ",parseInt(rJ),"/",parseInt(mJ),(parseInt(rJ)-1 > parseInt(mJ) || parseInt(rJ) < 0 ? "!!!!!!!!!!!!!!!!!!!!!!!!!!! Running illegal job !!!!!!!!!!!!!!!!!!!!!!!!!!!" : "")));
    return this.queue[index].task();
  }

  runNext() {
    let thisQueue = this;
    return () => {
      Promise.all([thisQueue.getAsync('paused'), thisQueue.getAsync('current'), thisQueue.getAsync('interval'), this.increment('runningjobs')])
        .then(([paused, current, interval]) => {
          this.pauseIfCapacity().then((pausedForCapacity) => {
            current = parseInt(current);
            interval = parseInt(interval);

            if(typeof paused === "string")
              paused = (paused === "true");
            if(paused || pausedForCapacity || thisQueue.index >= thisQueue.queue.length) {
              this.job = null;
              if(pausedForCapacity)
                this.unpauseIfCapacity();
              return;
            }

            thisQueue.index = thisQueue.index+1;
            let currentIndex = thisQueue.index;

            if((thisQueue.queue[currentIndex-1].queueNo < current)) {
              thisQueue.increment('ticket').then(queueNo => {
                queueNo = parseInt(queueNo);
                thisQueue.queue.push({
                  queueNo,
                  task: thisQueue.queue[currentIndex-1].task
                });

                thisQueue.runNext()();
              });
            } else {
              if(currentIndex < thisQueue.queue.length) {
                thisQueue.job = setTimeout(
                  thisQueue.runNext(),
                  (thisQueue.queue[currentIndex].queueNo-current-1)*interval);
              } else {
                thisQueue.job = null;
              }
              thisQueue.setAsync('current', thisQueue.queue[currentIndex-1].queueNo)
                .then(() => {
                  thisQueue.executeTask(currentIndex-1);
                });
            }
          }).finally(() => {
          this.decrement('runningjobs');
        });
      });
    }
  }

  async isOverCapacity() {
    let maxJobs = parseInt(await this.getAsync('maxjobs'));
    let runningJobs = parseInt(await this.getAsync('runningjobs'));

    if(maxJobs !== -1 && !isNaN(maxJobs) && runningJobs > maxJobs)
      return true;
    else
      return false;
  }

  async pause() {
    await this.setAsync('paused', true);

    this.job = null;
  }

  async pauseIfCapacity() {
    if(await this.isOverCapacity()) {
      if(verbose)
        await Promise.all([this.getAsync('runningjobs'), this.getAsync('maxjobs')]).then(([rJ, mJ]) => console.log("!!!!!!!!!!!!!!!!!!!!Pausing. Over capacity. Currently running jobs - ",parseInt(rJ),"/",parseInt(mJ),rJ > mJ ? `\t ${'▇'.repeat(rJ-mJ)}` : ""));

      await this.setAsync('overcapacity', true);

      this.job = null;

      this.startUnpauseTimeout();

      return true;
    } else {
      return false;
    }
  }

  async unpauseIfCapacity() {
    if(this.unpauseTimeout) {
      clearTimeout(this.unpauseTimeout);
      this.unpauseTimeout = null;
    }

    if(!(await this.isOverCapacity())) {
      if(verbose)
        await Promise.all([this.getAsync('runningjobs'), this.getAsync('maxjobs')]).then(([rJ, mJ]) => console.log("^^^^^^^^^^^^^^^^^^^^^Not over capacity anymore. Currently running jobs - ",parseInt(rJ),"/",parseInt(mJ)));
      await this.setAsync('overcapacity', false);

      if(!this.job && this.index < this.queue.length)
        this.start(true);
    } else {
      this.startUnpauseTimeout();
    }
  }

  async startUnpauseTimeout() {
    let interval = parseInt(await this.getAsync('interval'));
    if(this.unpauseTimeout) {
      clearTimeout(this.unpauseTimeout);
      this.unpauseTimeout = null;
    }

    this.unpauseTimeout = setTimeout(() => this.unpauseIfCapacity(), interval+Math.floor(Math.random()*interval));
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
    Promise.all([this.getAsync('paused'), this.getAsync('overcapacity'), this.getAsync('current'), this.getAsync('interval')]).then(([paused, overcapacity, current, interval]) => {
      if(typeof paused === "string")
        paused = (paused === "true");
      if(typeof overcapacity === "string")
        overcapacity = (overcapacity === "true");
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
      if(overcapacity) {
        this.job = null;

        if(!this.unpauseTimeout)
          this.startUnpauseTimeout();

        return;
      }
      if(this.job) {
        return;
      }
      this.job = setTimeout(this.runNext(), (this.queue[this.index].queueNo-current)*interval);
    })
  }
}

module.exports = ShardedIntervalQueue;