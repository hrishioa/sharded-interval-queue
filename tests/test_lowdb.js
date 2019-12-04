const ShardedIntervalQueue = require('../sharded-interval-queue');
const low = require('lowdb');
const FileAsync = require('lowdb/adapters/FileAsync');
let adapter;
let db;

let inputQueue = [];
let doneQueue = [];
let jobPromises = [];
let doneTimes = [];

async function runner(value) {
  let retStr = `${value} Run On ${Date.now()}`;
  doneTimes.push(Date.now());
  doneQueue.push(retStr);
  console.log("***************************** Run ", retStr);
  return retStr;
}

function timeout(ms) {
  console.log("waiting for ",ms);
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function testFunc() {
  adapter = new FileAsync('db.json');
  db = await low(adapter);

  let totalQueues = 5;
  let queues = [];
  let runners = [];
  let waitMaxMs = 1;
  let queueInterval = 1;
  let pauseMs = 1000;
  let pauseProbability = 0.1;
  let jobs = 20;
  for(let i=0; i<totalQueues; i++) {
    queues.push(new ShardedIntervalQueue("myQueue"));
    queues[queues.length-1].setStorageLowDB(db);
    await queues[queues.length-1].init(queueInterval, (i==0));
    runners.push(queues[queues.length-1].decorator(runner));
  }
  console.log("Initialized ",totalQueues, " queues");


  for(let i=0; i < jobs; i++) {
    let queueNo = Math.round(Math.random() * (totalQueues-1));
    if(Math.random() < pauseProbability) {
      console.log("Pausing for ",pauseMs);
      await queues[0].pause();
      await timeout(pauseMs);
      console.log("Starting again...");
      await Promise.all(queues.map(queue => queue.unpause()));
    }
    await timeout(Math.round(Math.random() * waitMaxMs));
    let inputStr = `Queue ${queueNo} Run ${i}`;
    inputQueue.push(inputStr);
    jobPromises.push(runners[queueNo](inputStr))
    console.log("********************* Enqueued ", inputStr);
  }

  console.log("Done with testfunc");
}

testFunc().then(() => {
  console.log("Waiting for jobPromises now...");
  return Promise.all(jobPromises);
}).then(vals => {
  console.log("jobPromises done");
  doneTimes = doneTimes.map((val, index) => index ? doneTimes[index]-doneTimes[index-1] : 0);
  console.log("input Queue - ", inputQueue);
  console.log("done Queue - ",doneQueue);
  console.log("Donetimes - ",doneTimes);
})