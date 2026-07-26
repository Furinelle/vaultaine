export function createSequentialTaskGate(): <T>(task: () => Promise<T>) => Promise<T> {
    let tail: Promise<unknown> = Promise.resolve();
    return task => {
        const run = tail.then(task);
        tail = run.then(() => undefined, () => undefined);
        return run;
    };
}
