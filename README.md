# Node.js WorkerPool

Create a pool of workers and execute a function or file in [worker threads](https://nodejs.org/api/worker_threads.html) and [child processes](https://nodejs.org/api/child_process.html).

### Features

- Workers are created only when needed and are terminated after a certain period of inactivity.
- If a successfully loaded worker is terminated by any of the following reasons, a new one will be created as necessary.
  - The worker is explicitly terminated by a call to [ChildProcess#kill](https://nodejs.org/api/child_process.html#subprocesskillsignal) or [Worker#terminate](https://nodejs.org/api/worker_threads.html#workerterminate).
  - The worker has terminated due to an unhandled exception.
  - A child process has been terminated by external means.
- Supports bidirectional communication with the worker.
- Post messages and send messages waiting for a response.
- Execute functions on the worker and force termination if the timeout has expired.
- Lightweight with full async-await support and timeouts.

### Transfer complex objects between workers

There are certain limitations concerning the data that can be transferred between threads and processes. Complex objects are transferred by using the [HTML structured clone algorithm](https://developer.mozilla.org/docs/Web/API/Web_Workers_API/Structured_clone_algorithm).

Thrown exceptions are automatically serialized as follows:

```js
class MyError extends Error { prop = 255; }
const error = new MyError('exception');
const serialized = {error, props: Object.assign({}, error)};
const deserialized = Object.assign(serialized.error, serialized.props);
console.log(deserialized);
```

## Installation

```
npm i flipeador/node-workerpool#semver:^1.0.0
```

## pseudo-Documentation

Start by instantiating a `WorkerPool` object.

- `script` — The module to run in the worker thread or child process. Worker threads also accept js code or a function; If js code is specified, it is placed inside a function called `main`.
- `options` — Options.
  - `workerType` — Worker type: `'thread'` or `'process'`. Defaults to `'thread'`.
  - `workerOptions` — Options passed to [child_process.fork](https://nodejs.org/api/child_process.html#child_processforkmodulepath-args-options) or [worker_threads.Worker](https://nodejs.org/api/worker_threads.html#class-worker).
  - `maxWorkers` — Maximum number of concurrent workers. Defaults to the maximum number of [logical CPU cores](https://nodejs.org/api/os.html#oscpus) minus 1.
  - `maxQueueSize` — Maximum number of tasks allowed to be queued. Defaults to `Infinity`.
  - `exitTimeout` — [MS] Determines how long to wait before a worker is terminated due to inactivity. Defaults to 5 minutes.
  - `heapSizeLimit` — [MB] Maximum memory usage for child processes ([--max-old-space-size](https://nodejs.org/api/cli.html#--max-old-space-sizesize-in-megabytes)).

```js
const workerpool = new WorkerPool(script, options);
```

Create a task that allows bidirectional communication with a worker.

The `WorkerPool#task` method returns a promise that resolves to a `Task` object once an available worker has been associated with the task.

```js
const task = await workerpool.task();
```

When the task is no longer needed, it is important to call the `Task#done` method to release the associated worker, so that other tasks can reuse it.

This method can be called at any time, the worker will not be released until all the requests have been handled, but once called, the `Task` object can no longer be used for further communication.

The `Task#done` method returns a promise that resolves once the associated worker is terminated or becomes available for another task.
If the promise is taking too long to resolve, worker termination can be forced by calling `Task#terminate`, but this will cancel any pending response.

```js
// returns undefined if the worker still exists
const exitCode = await task.done();
```

---

If a module has been passed to `WorkerPool`, the worker module must instantiate a `Worker` object.

- The `WorkerPool` and `Worker` objects extends [EventEmitter](https://github.com/flipeador/node-eventemitter), so listener functions can be registered.
- The `Worker#init` method initializes the module to enable communication with `WorkerPool`.

```js
new Worker()
.on('message', async (message) => {
    // do something with the message
    return 'response';
})
.init({
    // functions available for execution
    main(...args) {
        return 'result';
    }
});
```

---

See [examples](#examples) for more information.

## Examples

<details>
<summary><h4>Demonstrates the behavior of the workerpool</h4></summary>

```js
import process from 'node:process';
import readline from 'node:readline';
import url from 'node:url';

import { WorkerPool, Worker } from '@flipeador/node-workerpool';

const __filename = url.fileURLToPath(import.meta.url);

function pause(message) {
    const rl = readline.createInterface(process.stdin, process.stdout);
    return new Promise(resolve => {
        rl.question(
            `${message}\nPress any key to continue...`,
            answer => rl.close(resolve(answer))
        );
    });
}

if (Worker.isMainProcess())
{
    const workerpool = new WorkerPool(__filename, {
        workerType: 'process',
        maxWorkers: 3
    });

    await pause(`Open the task manager and locate process id ${process.pid}.`);

    while (true) {
        const ptask = workerpool.task();
        if (!ptask.worker) console.log(
            'Waiting for a worker to become available.'
          + '\nTry to terminate a child process from the task manager.'
        );
        const task = await ptask;
        await pause(`A new child process has been created (${task.id}).`);
    }
}
else
{
    new Worker().init();
}
```

```
Open the task manager and locate process id 12384.
Press any key to continue...
A new child process has been created (13540).
Press any key to continue...
A new child process has been created (4444).
Press any key to continue...
A new child process has been created (6972).
Press any key to continue...
Waiting for a worker to become available.
Try to terminate a child process from the task manager.
A new child process has been created (9700).
Press any key to continue...
```

</details>

<details>
<summary><h4>Execute a function in a worker thread</h4></summary>

> [!WARNING]
> This is currently not supported for child processes.

```js
import { WorkerPool } from '@flipeador/node-workerpool';

async function worker(param)
{
    // Listener functions can be async if needed.
    this.on('message', m => `${m} received!`); // (1)
    this.once('done', () => console.log('Done!')); // (2)

    const result = await this.send('Hello'); // (3)
    return result[0] + param;
}

const workerpool = new WorkerPool(worker, {
    exitTimeout: 1000
});

const task = await workerpool.task();

task.on('message', async (message) => {
    return `${message} World`; // (3)
});

try {
    // 'execute' returns the result, or throws an exception in case of error.
    console.log(await task.execute('worker', ['!'])); // (2) 'Hello World!'
    // 'send' returns a list of results, including exceptions.
    console.log(await task.send('message')); // (1) [ 'message received!' ]
} finally {
    task.done();
}
```

```
Hello World!
[ 'message received!' ]
Done!
```

</details>

<details>
<summary><h4>Execute JavaScript code in a worker thread</h4></summary>

> [!WARNING]
> This is currently not supported for child processes.

```js
import { WorkerPool } from '@flipeador/node-workerpool';

const script = 'return 3 * args[0];';

const workerpool = new WorkerPool(script, {
    exitTimeout: 1000
});

const task = await workerpool.task();

task.execute('main', [5])
    .then(console.log, console.error);
task.done();
```

```
15
```

</details>

<details>
<summary><h4>Execute a module in a child process</h4></summary>

```js
import url from 'node:url';

import { WorkerPool, Worker } from '@flipeador/node-workerpool';

const __filename = url.fileURLToPath(import.meta.url);

if (Worker.isMainProcess())
{
    const workerpool = new WorkerPool(__filename, {
        workerType: 'process',
        exitTimeout: 1000
    });

    const task = await workerpool.task();

    task.post('Child Process'); // (1)
    task.execute('main', ['Main', 'Process'])
        .then(console.log, console.error); // (2)
    task.done();
}
else
{
    new Worker()
        .on('message', message => {
            console.log(`${message}!`); // (1)
        })
        .init({
            main(main, process) {
                return `${main} ${process}!`; // (2)
            }
        });
}
```

```
Child Process!
Main Process!
```

</details>

<details>
<summary><h4>Execute a worker thread from a child process</h4></summary>

```js
import url from 'node:url';

import { WorkerPool, Worker } from '@flipeador/node-workerpool';

const __filename = url.fileURLToPath(import.meta.url);

if (Worker.isMainProcess())
{
    console.log('Main Process');

    const workerpool = new WorkerPool(__filename, {
        workerType: 'process',
        exitTimeout: 1000
    });

    const task = await workerpool.task();

    task.execute('main')
        .then(console.log, console.error);
    task.done();
}
else
{
    console.log('↳Child Process');

    new Worker().init({
        async main() {
            function worker()
            {
                console.log(' ↳Worker Thread');
                return 'Hello World!';
            }

            const workerpool = new WorkerPool(worker);
            const task = await workerpool.task();

            try {
                return await task.execute('worker');
            } finally {
                task.done();
            }
        }
    });
}
```

```
Main Process
↳Child Process
 ↳Worker Thread
Hello World!
```

</details>

<details>
<summary><h4>Limit the maximum memory usage of child processes</h4></summary>

```js
import v8 from 'node:v8';
import url from 'node:url';

import { WorkerPool, Worker} from '@flipeador/node-workerpool';

const __filename = url.fileURLToPath(import.meta.url);

if (Worker.isMainProcess())
{
    const workerpool = new WorkerPool(__filename, {
        workerType: 'process',
        heapSizeLimit: 500, // ~500 MB
        exitTimeout: 1000
    });
    const task = await workerpool.task();
    task.done();
}
else
{
    const stats = v8.getHeapStatistics();
    console.log('Used heap size:', Math.round(stats.used_heap_size/1024**2), 'MB');
    console.log('Heap size limit:', Math.round(stats.heap_size_limit/1024**2), 'MB');
    new Worker().init();
}
```

```
Used heap size: 6 MB
Heap size limit: 548 MB
```

</details>

<details>
<summary><h4>Spawn an executable file as a new child process</h4></summary>

This is a convenient promisified version of [child_process.execFile](https://nodejs.org/api/child_process.html#child_processexecfilefile-args-options-callback).

```js
import { execPath } from 'node:process';
import { Process } from '@flipeador/node-workerpool';

console.log(execPath);
Process.execute(execPath, ['--version'], {
    //data: 'stdin', timeout: 1000
}).then(console.log);
```

</details>

## License

This project is licensed under the **Apache License 2.0**. See the [license file](LICENSE) for details.
