# Sharded Interval Queue

A no-dependencies, persistent store sharded queue that runs async functions in timed intervals while preserving ordering. A simpler single-process version is [Async Interval Queue](https://www.npmjs.com/package/async-interval-queue), which works in single-threaded environments. Run out of the box using the integrated global object for testing, then connect a persistent adapter of your choice. Integrated support for [LowDB](https://github.com/typicode/lowdb) (slower, but quick and easy persistence), or [Redis](https://github.com/NodeRedis/node_redis) for much faster and scalable persistent caching. Roll your own otherwise, it's pretty easy.

Integrated decorator to wrap your functions. Comes with some tests for global object, lowdb and redis adapters to test your implementation.

## Installation

```bash
npm install sharded-interval-queue
```

## Usage

### Out-of-the-box

> This is only for using multiple connected queues within the same namespace. For other options, look at the [LowDB](#LowDB), [Redis](#Redis) implementations or [Roll your own](#Custom-adapters).

Let's create two new connected queues and an async job:

```javascript
const ShardedIntervalQueue = require('sharded-interval-queue');

let queue1 = new ShardedIntervalQueue("MyQueue"); // Create new queue with name
await queue1.init(1000); // Initialize with interval of 1 second
let queue2 = new ShardedIntervalQueue("MyQueue"); // Create new queue with name
await queue2.init(1000); // Initialize with interval of 1 second

async function job(value1, value2) {
  return `Hello to ${value1} and ${value2}!`;
}
```

Next, we can enqueue them using a thunk or a decorator:

```javascript
// Decorator
let wrappedJob = queue1.decorator(job);
wrappedJob("John","Me").then(console.log);

// Thunk city
queue2.add(() => job("Martha","Wayne")).then(console.log);
```

The queue starts by default on a job being added. The second parameter to add can be set to true to prevent this.
The queue will stop when there are no jobs left. You can restart it manually, or add a job without the [doNotStart parameter](#optional-parameters).

You can also pause all queues from any queue instance:

```javascript
await queue1.pause();
```

However, this implementation focuses on being efficient, so there are no hooks or recurring intervals to restart the queues when they're unpaused - you must write your own if you need this functionality. Otherwise, adding a job by default resumes execution if the queue is unpaused, or you can start the queue manually with `start` or `unpause`:

```javascript
await queue2.unpause();
queue1.start();
```

And this will start both queues.

### LowDB

[LowDB](https://github.com/typicode/lowdb) is a simple JSON file based database. Install it with:

```bash
npm install lowdb
```

Once that's done, choose a file and connect the adapter to your queues, but make sure you do it before you initialize them:

```javascript
const low = require('lowdb');
const FileAsync = require('lowdb/adapters/FileAsync');
let adapter = new FileAsync('db.json');
let db = await low(adapter);

const ShardedIntervalQueue = require('sharded-interval-queue');

let lowQueue = new ShardedIntervalQueue("MyQueue"); // Create new queue with name
lowQueue.setStorageLowDB(db);
await lowQueque.init(1000); // Initialize with interval of 1 second
```

That's it! You can use the additional parameter in [setStorageLowDB and init](#optional-parameters) to reset queues upon initialization, or to reinitialize the lowdb adapter.

[test_lowdb.js](https://github.com/hrishioa/sharded-interval-queue/blob/master/tests/test_lowdb.js) in the tests folder has an extended example of how to do this.

### Redis

Install the [Redis Client](https://github.com/NodeRedis/node_redis) for node:

```bash
npm install redis
```

Then initialize your instance of redis and connect it to the queue:

```javascript
const redis = require("redis");
const client = redis.createClient();

const ShardedIntervalQueue = require('./sharded-interval-queue');

let redisQueue = new SharedIntervalQueue("myQueue");
redisQueue.setStorageRedis(client);
await redisQueue.init(1000);
```

Same as lowDB, you can use the additional parameter in [setStorageLowDB and init](#optional-parameters) to reset queues upon initialization, or to reinitialize redis key states.

[test_redis.js](https://github.com/hrishioa/sharded-interval-queue/blob/master/tests/test_redis.js) in the tests folder has an extended example of how to do this.

## Custom Adapters

Setting a custom adapter is not much more difficult. Each queue uses five **async** functions to interact with shared state, so you can write any implementation you'd like:

* `initStorage()` - when called this function must initialize the adapter. Can be left empty if your adapter (unlike lowdb) does not need initialization.
* `isSet(queueName, key)` - called with a queue name and a key, must return true if the key is set, and false otherwise.
* `setAsync(queueName, key, value)` - called with a queue name, key and a value, must set this key to storage.
* `getAsync(queueName, key)` - called with a queue name and a key, must return the valye of the key.
* `incrementAsync(queueName, key)`- called with a queue name and key, must increment and return the *incremented* value (ideally atomic).

You can then set the functions using `setStorageCustom`. Here's a (bad) example:

```javascript
const ShardedIntervalQueue = require('./sharded-interval-queue');

let localQueue = new SharedIntervalQueue("myQueue");

let myStorage = {};

isSet = async (queueName, key) => ((queueName+key) in myStorage);
setAsync = async (queueName, key, value) => myStorage[queueName+key] = value;
getAsync = async (queueName, key) => myStorage[queueName+key];
incrementAsync = async (queueName, key) => { myStorage[queueName+key]++; return myStorage[queueName+key]; }

localQueue.setStorageCustom(null, isSet, getAsync, setAsync, incrementAsync);
```

Once done, `init` your queue and carry on! Please feel free to submit a pull request to add more adapters if you'd like.

## Optional parameters

Each queue has the following functions and optional parameters:

* setStorageLowDB(db, **skipInit**) - If set to true, `skipInit` will skip an initialization function for the database.
* init(intervalMs, **reset**, **failIfExists**) - If `reset` is set to true, the queue variables will be reset and set to their init states. If `failExists` is true, the queue creation will throw an exception if the queue already exists.
* add(asyncFunction, **doNotStart**) - If set to true, `doNotStart` will keep the queue from starting when this job is added.
* decorator(asyncFunction, **doNotStart**) - If set to true, `doNotStart` will keep the queue from starting when this decorator is used.
* start(**silent**) - The default behavior of start is to throw exceptions if the queue is already running or empty. To silence, set `silent` to true.

## Possible issues

Sharded Interval Queue is young and still needs work. Not much error handling or parameter checking is implemented, so any invalid states you push in may cause crashes. If this happens, please report the issues and I'll do my best to resolve them.

## License

[MIT](https://choosealicense.com/licenses/mit/)