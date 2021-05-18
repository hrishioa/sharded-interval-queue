const redis = require("redis");
const client = redis.createClient();
const ShardedIntervalQueue = require('../sharded-interval-queue');

let inputQueue = [];
let doneQueue = [];
let jobPromises = [];
let doneTimes = [];
let queues = [];

async function printQueue(index) {
  return {
    maxjobs:await queues[index].getAsync('maxjobs'),
    runningjobs:await queues[index].getAsync('runningjobs'),
    overcapacity:await queues[index].getAsync('overcapacity'),
    tickets:await queues[index].getAsync('ticket'),
    paused:await queues[index].getAsync('paused'),
    current:await queues[index].getAsync('current'),
    isOvercapacity:await queues[index].isOverCapacity(),
    job: await queues[index].job,
    index: await queues[index].index,
    queueLength: await queues[index].queue.length
  }
}

async function viewQueues() {
  for(let i=0;i<queues.length;i++) {
    console.log("\nQueue ",i,":",await printQueue(i));
  }
}

async function manuallyUnpause() {
  for(let i=0;i<queues.length;i++) {
    console.log("\nUnpausing queue ",i);
    await queues[i].unpauseIfCapacity();
  }
}

async function runner(value, index, timeoutMs) {
  let retStr = `${value} Run On ${Date.now()}`;
  await timeout(timeoutMs, "Job "+value+" running, ");
  doneTimes.push(Date.now());
  doneQueue.push(retStr+` - distance from order: ${doneQueue.length-index} \t${(doneQueue.length < index ? '-':'+').repeat(Math.abs(doneQueue.length-index))}`);
  console.log("***************************** Run ", retStr);
  return retStr;
}

function timeout(ms, reason) {
  console.log(reason+" waiting for ",ms);
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function testFunc() {
  inputQueue = [];
  doneQueue = [];
  jobPromises = [];
  doneTimes = [];
  queues = [];

  let totalQueues = 10;
  let runners = [];
  let waitMaxMs = 1;
  let queueInterval = 1;
  let pauseMs = 0;
  let pauseProbability = 0.1;
  let jobs = 1000;
  let jobDelayMs = 500;
  let maxJobs = 20;

  for(let i=0; i<totalQueues; i++) {
    queues.push(new ShardedIntervalQueue("myQueue"));
    queues[queues.length-1].setStorageRedis(client);
    await queues[queues.length-1].init(queueInterval, (i==0), null, maxJobs);
    runners.push(queues[queues.length-1].decorator(runner));
  }
  console.log("Initialized ",totalQueues, " queues");


  for(let i=0; i < jobs; i++) {
    let queueNo = Math.round(Math.random() * (totalQueues-1));
    if(pauseMs && Math.random() <= pauseProbability) {
      console.log("Pausing for ",pauseMs);
      await queues[0].pause();
      await timeout(pauseMs, "Pause timeout");
      console.log("Starting again...");
      await Promise.all(queues.map(queue => queue.unpause()));
    }
    await timeout(Math.round(Math.random() * waitMaxMs), "Pause before starting next job");
    let inputStr = `Queue ${queueNo} Run ${i}`;
    inputQueue.push(inputStr);
    jobPromises.push(runners[queueNo](inputStr, i, jobDelayMs))
    console.log("********************* Enqueued ", inputStr+"\n");
    console.log("Values: ticket: ",await queues[queueNo].getAsync('ticket'), ", current: ",await queues[queueNo].getAsync('current'), ", interval: ",await queues[queueNo].getAsync('interval'), ", paused: ",await queues[queueNo].getAsync('paused'), ", overcapacity: ", await queues[queueNo].getAsync('overcapacity'));
  }

  console.log("Done with testfunc");
}

// reporter = setInterval(() => console.log(`done: ${doneTimes.length}/${inputQueue.length}`), 2000);
// testFunc();


testFunc().then(() => {
  console.log("Waiting for jobPromises now...");
  setInterval(() => console.log(`done: ${doneTimes.length}/${inputQueue.length}`), 2000);
  return Promise.all(jobPromises);
}).then(vals => {
  console.log("jobPromises done");
  doneTimes = doneTimes.map((val, index) => index ? doneTimes[index]-doneTimes[index-1] : 0);
  console.log("input Queue - ", inputQueue);
  console.log("done Queue - ",doneQueue.join("\n"));
  console.log("Donetimes - ",doneTimes);
  process.exit(0);
})