const ShardedIntervalQueue = require('./sharded-interval-queue');

let inputQueue = [];
let doneQueue = [];
let jobPromises = [];
let doneTimes = [];
let inputIndices = [];
let doneIndices = [];

async function runner(value, jobIndex) {
  let retStr = `${value} Run On ${Date.now()}`;
  doneTimes.push(Date.now());
  doneQueue.push(retStr);
  doneIndices.push(jobIndex);
  console.log("***************************** Run ", retStr);
  return retStr;
}

function timeout(ms) {
  console.log("waiting for ",ms);
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function testFunc(totalQueues, waitMaxMs, queueInterval, pauseMs, pauseProbability, jobs) {
  let queues = [];
  let runners = [];
  let pauses = 0;
  for(let i=0; i<totalQueues; i++) {
    queues.push(new ShardedIntervalQueue("myQueue"));
    await queues[queues.length-1].init(queueInterval, true);
    runners.push(queues[queues.length-1].decorator(runner));
  }
  console.log("Initialized ",totalQueues, " queues");


  for(let i=0; i < jobs; i++) {
    let queueNo = Math.round(Math.random() * (totalQueues-1));
    if(Math.random() <= pauseProbability) {
      pauses++;
      console.log("Pausing for ",pauseMs);
      await queues[0].pause();
      await timeout(pauseMs);
      console.log("Starting again...");
      await Promise.all(queues.map(queue => queue.unpause()));
    }
    await timeout(Math.round(Math.random() * waitMaxMs));
    let inputStr = `Queue ${queueNo} Run ${i}`;
    inputQueue.push(inputStr);
    inputIndices.push(i);
    jobPromises.push(runners[queueNo](inputStr, i))
    console.log("********************* Enqueued ", inputStr);
  }

  console.log("Waiting for jobpromises");
  await Promise.all(jobPromises);
  console.log("Jobs done");

  doneTimes = doneTimes.map((val, index) => index ? doneTimes[index]-doneTimes[index-1] : 0);

  let timeTaken = doneTimes.reduce((total, current) => total+current);
  console.log("Total time taken = ",timeTaken);
  let actualTimeTaken = timeTaken - (pauses*pauseMs);
  console.log("Queue runtime - ",actualTimeTaken);
  let throughput = actualTimeTaken/jobPromises.length;
  console.log("Time per job - ",throughput);

  console.log("Input indices - ",inputIndices);
  console.log("Done indices - ",doneIndices);
  console.log("Tests passed - ", inputIndices.map((val, index) => (doneIndices[index] === val)).reduce((acc, cur) => acc && cur));
}

testFunc(5, 10, 10, 100, 0.1, 20).then(() => {
  console.log("Waiting for jobPromises now...");
});