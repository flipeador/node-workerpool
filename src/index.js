/*
    Create a pool of workers and execute a function or file in worker threads and child processes.
    https://github.com/flipeador/node-workerpool
*/

import fs from 'node:fs';
import os from 'node:os';
import util from 'node:util';
import process from 'node:process';
import threading from 'node:worker_threads';
import processing from 'node:child_process';

// https://github.com/flipeador/js-promise
import { PromiseTimeout, PromiseEx } from '@flipeador/js-promise';
export { PromiseTimeout };
// https://github.com/flipeador/js-eventemitter
import { EventEmitter } from '@flipeador/js-eventemitter';

function format(message, ...args)
{
    return util.format(message, ...args.map(x => util.inspect(x)));
}

function params(x)
{
    return x instanceof Array ? x
        : x === undefined ? [] : [x];
}

function remove(array, value)
{
    const index = array.indexOf(value);
    if (index !== -1)
        array.splice(index, 1);
    return index;
}

async function call(executors, method, ctx, args)
{
    const fn = executors?.[method];
    if (typeof(fn) !== 'function')
        return { error: format('Invalid function %s: %s', method, fn) };
    try {
        return { value: await fn.call(ctx, ...params(args)) };
    } catch (error) {
        return { error: serializeError(error) };
    }
}

function result(result)
{
    if (result.error)
        throw typeof(result.error) === 'string'
            ? new WorkerError(result.error)
            : deserializeError(result.error);
    return result.value;
}

function serializeError(error)
{
    return {
        error,
        props: error instanceof Error
            ?  { ...error }
            : undefined
    };
}

function deserializeError(obj)
{
    return obj.error instanceof Error
        ? Object.assign(obj.error, obj.props)
        : obj.error;
}

function serializeErrors(errors)
{
    if (!errors) return errors;
    return errors.map(serializeError);
}

function deserializeErrors(errors)
{
    if (!errors) return errors;
    return errors.map(deserializeError);
}

export class WorkerError extends Error {
    constructor(message, ...args) {
        super(format(message, ...args));
    }
}

export class WorkerQueueFull extends WorkerError {
    constructor(size) {
        super('Queue task limit reached: %s', size);
    }
}

export class WorkerTerminate extends WorkerError {
    constructor(code) {
        code ??= 1;
        super('The worker thread has been terminated with code %s', code);
        this.code = code;
    }
}

export class WorkerCanceled extends WorkerError {
    constructor() {
        super('The operation has been canceled');
    }
}

export class Thread
{
    type = 'thread';

    /**
     * Create a Thread object.
     * @param {String|Function} script
     * The module, function or js code to run in the worker thread.
     * If js code is specified, it is placed inside a function called `main`.
     */
    constructor(script, options)
    {
        options ??= {};
        options.eval = !fs.existsSync(`${script}`);
        if (typeof(script) === 'function')
            script = this.#eval(script, script.name);
        else if (options.eval)
            script = this.#eval(`async function main(...args){${script}}`);
        this._worker = new threading.Worker(script, options);
    }

    /**
     * Terminate the worker thread.
     * @return {Promise<Number>} Exit code.
     */
    terminate()
    {
        return this._worker.terminate();
    }

    /**
     * Send a message to the worker thread.
     * @param message Value compatible with the `HTML structured clone algorithm`.
     */
    post(message)
    {
        this._worker.postMessage(message);
        return Promise.resolve(this);
    }

    #eval(code, name='main')
    {
        code = `async function(){${code};new this.Worker().init({${name}});}`;
        return `import('@flipeador/node-workerpool').then(_=>{(${code}).call(_)})`;
    }
}

export class Process
{
    type = 'process';

    /**
     * Create a Process object.
     * @param {String} file The module to run in the child process.
     */
    constructor(file, options)
    {
        options ??= {};
        this._worker = processing.fork(file, {
            serialization: 'advanced',
            ...options
        });
    }

    /**
     * Forcefully terminate the child process.
     * @param {Number} code Exit code.
     * @return {Boolean} Returns `true` if succeeds, or `false` otherwise.
     */
    terminate(code)
    {
        if (code !== undefined)
            this._worker.exitCode = code;
        return this._worker.kill('SIGKILL');
    }

    /**
     * Send a message to the child process.
     * @param message Value compatible with the `HTML structured clone algorithm`.
     * @return {Promise<this>}
     */
    post(message)
    {
        return new Promise((resolve, reject) => {
            this._worker.send(message, error => {
                if (error) reject(error);
                else resolve(this);
            });
        });
    }

    /**
     * Spawn a executable file as a new child process.
     * @param {String} file The file to execute.
     * @param {String[]} args List of string arguments.
     * @param {Object} options Options: `data` (stdin) | `timeout`.
     * @returns {Promise<String>} The stdout from the command.
     */
    static execute(file, args, options={})
    {
        return new Promise((resolve, reject) => {
            processing.execFile(file, params(args), options
            , (error, stdout, stderr) => {
                if (error) return reject(
                    Object.assign(error, {file, args, options})
                );
                if (stderr.length) return reject(
                    Object.assign(new WorkerError(stderr), {stdout, file, args, options})
                );
                resolve(stdout);
            }).stdin.end(options?.data);
        });
    }
}

export class Message
{
    constructor(type, content, id, sourceType)
    {
        Object.assign(this, {type, content, id, sourceType});
    }

    setId(id)
    {
        return Object.assign(this, {id});
    }
}

class MessageQueue extends Map
{
    create(id, timeout)
    {
        return new PromiseEx((resolve, reject) => {
            this.set(id, {resolve, reject});
        }, {timeout, onSettled: () => this.delete(id)});
    }

    resolve(message)
    {
        const promise = this.get(message.id);
        if (message.sourceType === 'message')
            message.content = deserializeErrors(message.content);
        promise.resolve(message.content);
        return promise;
    }

    rejectAll(error)
    {
        for (const promise of this.values())
            promise.reject(error);
    }

    id()
    {
        return process.uptime().toString();
    }
}

export class Task extends EventEmitter
{
    _queue = new MessageQueue();

    /**
     * Create a Task object.
     * @param {Process|Thread} worker The worker associated with the task.
     */
    constructor(worker)
    {
        super('message', 'done');

        if (!(worker instanceof Process || worker instanceof Thread))
            throw new WorkerError('Invalid worker: %s', worker);

        this._worker = worker;

        this.id = worker._worker.pid ?? worker._worker.threadId;

        this._promise = new Promise(resolve => {
            this.once('done', code => {
                this.removeAllListeners();
                //if (code !== undefined)
                this._queue.rejectAll(new WorkerTerminate(code));
                delete this._queue;
                delete this._worker;
                this._done = true;
                resolve(code);
            });
        });
    }

    /**
     * Post a message to the worker thread or child process.
     * @param message Value compatible with the `HTML structured clone algorithm`.
     */
    post(message)
    {
        this.#check();
        return this._worker.post(
            message instanceof Message
            ? message
            : new Message('message', message)
        );
    }

    /**
     * Send a message to the worker and wait for response.
     * @param message Value compatible with the `HTML structured clone algorithm`.
     * @param {Number} timeout Timeout, in milliseconds. Throws {@link PromiseTimeout}.
     * @return {Promise<Array>} List of results, including exceptions.
    */
    async send(message, timeout)
    {
        this.#check();
        if (!(message instanceof Message))
            message = new Message('message', message);
        await this.post(message.setId(this._queue.id()));
        return this._queue.create(message.id, timeout);
    }

    /**
     * Execute a function on the worker and wait for the result.
     * @param {String} method The name of the function to be executed.
     * @param {Array} args List of arguments.
     * @param {Number} timeout Timeout, in milliseconds. Throws {@link PromiseTimeout}.
     * @remarks If the timeout expires, the worker is forcefully terminated.
     */
    async execute(method, args, timeout)
    {
        this.#check();
        try {
            return result(await this.send(
                new Message('exec', {method, args}),
                timeout
            ));
        } catch (error) {
            if (error instanceof PromiseTimeout)
                this.terminate();
            throw error;
        }
    }

    /**
     * Post a message to the worker indicating that the current task is completed.
     * Resolves when the associated worker is terminated or becomes available for another task.
     */
    async done()
    {
        if (!this._done) {
            this.post(new Message('done'));
            this._done = true;
        }
        return this._promise;
    }

    /**
     * Terminate the worker associated with the task.
     * @return {Promise<Number>} Resolves with the exit code once the associate worker is terminated.
     */
    async terminate()
    {
        this._worker.terminate();
        this._done = true;
        return this._promise;
    }

    #check()
    {
        if (this._done)
            throw new WorkerError('The task is no longer valid');
    }
}

export class WorkerPool
{
    _workers = [];
    _tasks = { list: [], pending: 0, promises: [] };

    /**
     * Create a WorkerPool object.
     * Workers are created when needed and are terminated after a certain period of inactivity.
     * @param {String|Function} script The module to run in the worker thread or child process.
     * @param {Object} options Options.
     * @param {'thread'|'process'} options.workerType Worker type: `thread` or `process`.
     * @param {Object} options.workerOptions Worker options.
     * @param {Number} options.maxWorkers Maximum number of concurrent workers.
     * @param {Number} options.maxQueueSize Maximum number of tasks allowed to be queued.
     * @param {Number} options.exitTimeout Workers are terminated after this period of inactivity.
     * @param {Number} options.heapSizeLimit Maximum memory usage for child processes, in megabytes.
     */
    constructor(script, options)
    {
        this._script = script;

        this._maxWorkers = Math.max(1, options?.maxWorkers??os.cpus().length-1);
        this._maxQueueSize = Math.max(1, options?.maxQueueSize??Infinity);
        this._exitTimeout = parseInt(options?.exitTimeout ?? 300_000);
        this._workerType = options?.workerType ?? 'thread';
        this._workerOptions = options?.workerOptions ?? {};

        if (this._workerType === 'process') {
            this._workerOptions.execArgv ??= [...process.execArgv];
            if (options?.heapSizeLimit)
                this._workerOptions.execArgv.push(`--max-old-space-size=${options.heapSizeLimit}`);
        }
    }

    /**
     * Create a task that allows bidirectional communication with a worker.
     * @return {Promise<Task>} Resolves with {@link Task} once a worker becomes available.
     */
    task()
    {
        if (this._tasks.list.length >= this._maxQueueSize)
            throw new WorkerQueueFull(this._tasks.list.length);

        const obj = { };

        const promise = new Promise((resolve, reject) => {
            if (this._tasks.promises.length) {
                this._tasks.promises.shift()({resolve, reject});
            } else {
                const task = {resolve, reject};
                this._tasks.list.push(task);
                try {
                    obj.worker = this.#createWorker();
                    obj.worker?.catch(reject);
                } catch (error) {
                    remove(this._tasks.list, task);
                    reject(error);
                }
            }
        });

        return Object.assign(promise, obj);
    }

    #createWorker()
    {
        if (this._workers.length >= this._maxWorkers
            || (this._tasks.list.length - this._tasks.pending) <= 0)
            return null;

        return new Promise((resolve, reject) => {
            let worker;
            if (this._workerType === 'thread')
                this._workers.push(worker = new Thread(this._script, this._workerOptions));
            else if (this._workerType === 'process')
                this._workers.push(worker = new Process(this._script, this._workerOptions));
            else throw new WorkerError('Invalid worker type: %s', this._workerType);

            worker._pending = ++this._tasks.pending;

            // Emitted when the child process has spawned successfully.
            // Emitted when the worker thread has started executing JavaScript code.
            worker._worker.on(
                worker.type === 'process' ? 'spawn' : 'online',
                () => worker._started = !resolve(worker)
            );

            worker._worker.on('message', async (message) => {
                let result;

                switch (message.type)
                {
                    case 'ready':
                        // At this point, the worker is considered successfully loaded.
                        worker._ready = !this.#dispose(worker);

                        let task = this._tasks.list.shift();

                        if (!task) {
                            worker._waitp = new PromiseEx(resolve => {
                                this._tasks.promises.push(resolve);
                            }, {
                                timeout: this._exitTimeout,
                                args: [this],
                                onTimeout() { this.resolve(); },
                                onSettled(_, workerpool) {
                                    remove(workerpool._tasks.promises, this.resolve);
                                }
                            });
                            task = await worker._waitp;
                            delete worker._waitp;
                        }

                        if (task)
                            task.resolve(worker._task = new Task(worker));
                        else if (task === undefined) // timeout
                            worker.terminate();
                        break;
                    case 'message':
                        result = serializeErrors(await worker._task.emit2('message', message.content, false));
                        break;
                    case 'response':
                        worker._task._queue.resolve(message);
                        break;
                }

                if (message.id && message.type !== 'response')
                    worker.post(new Message('response', result, message.id, message.type));
            });

            worker._worker.on('error', (error) => {
                // If the child process could not be spawned:
                if (!worker._started) {
                    reject(error);
                    this.#dispose(worker, null);
                // If the worker thread throws an uncaught exception:
                } else if (worker.type === 'thread') {
                    console.error(error);
                }
            });

            worker._worker.once('exit', (code) => {
                worker._waitp?.resolve(null);
                this.#dispose(worker, code??137);
                if (worker._ready) this.#createWorker();
            });
        });
    }

    #dispose(worker, code)
    {
        if (code !== undefined)
            remove(this._workers, worker);

        if (worker._pending) {
            --this._tasks.pending;
            delete worker._pending;
        }

        if (worker._task) {
            try {
                worker._task.emit('done', code);
            } finally {
                delete worker._task;
            }
        }
    }
}

export class Worker extends EventEmitter
{
    _queue = new MessageQueue();
    _tasks = [];

    /**
     * Create a Worker object.
     * @remarks This object must be created by a worker thread or child process.
     */
    constructor()
    {
        super('message', 'done');
    }

    /**
     * Initialize the worker thread or child process.
     * @param {Object} executors Functions available for execution.
     */
    init(executors)
    {
        const ctx = threading.parentPort || process;
        const events = this.events();

        ctx.on('message', async (message) => {
            if (message.type !== 'done')
                this._tasks.push(new PromiseEx());

            let result;

            switch (message.type)
            {
                case 'message':
                    result = serializeErrors(await this.emit2('message', message.content, false));
                    break;
                case 'response':
                    this._queue.resolve(message);
                    break;
                case 'exec':
                    result = await call(executors, message.content.method, this, message.content.args);
                    break;
                case 'done':
                    const tasks = Promise.all(this._tasks);
                    try {
                        await this.emit2('done', tasks);
                    } finally {
                        await tasks;
                        this.events(events);
                        this._queue.rejectAll(new WorkerCanceled());
                        this.post(new Message('ready'));
                    }
                    break;
            }

            if (message.id && message.type !== 'response')
                this.post(new Message('response', result, message.id, message.type));

            if (message.type !== 'done')
                this._tasks.shift().resolve();
        });

        this.post(new Message('ready'));
    }

    /**
     * Post a message to the parent worker.
     * @param message Value compatible with the `HTML structured clone algorithm`.
     * @return {Promise<this>}
    */
    async post(message)
    {
        if (!(message instanceof Message))
            message = new Message('message', message);

        if (threading.parentPort) {
            threading.parentPort.postMessage(message);
            return Promise.resolve(this);
        }

        return new Promise((resolve, reject) => {
            process.send(message, error => {
                error ? reject(error) : resolve(this);
            });
        });
    }

    /**
     * Send a message to the parent worker and wait for response.
     * @param message Value compatible with the `HTML structured clone algorithm`.
     * @param {Number} timeout Timeout, in milliseconds. Throws {@link PromiseTimeout}.
     * @return {Promise<Array>} List of results, including exceptions.
    */
    async send(message, timeout)
    {
        if (!(message instanceof Message))
            message = new Message('message', message);

        await this.post(message.setId(this._queue.id()));
        return this._queue.create(message.id, timeout);
    }

    /**
     * Check if the current thread is the main thread.
     */
    static isMainThread()
    {
        return threading.isMainThread;
    }

    /**
     * Check if the current process is the main process.
     */
    static isMainProcess()
    {
        return process.send === undefined;
    }
}

export default {
    WorkerError,
    WorkerQueueFull,
    WorkerTerminate,
    WorkerCanceled,
    PromiseTimeout,
    Thread,
    Process,
    Message,
    Task,
    WorkerPool,
    Worker
};
