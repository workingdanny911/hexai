import EventEmitter from "node:events";

export interface PipeControl<O> {
    next(output: O): Promise<void>;
}

type PipeFunction<I = unknown, O = unknown> = (
    input: I,
    control: PipeControl<O>
) => void | Promise<void>;

export type PipeLike<I, O> = PipeFunction<I, O> | Pipe<I, O>;

export type AnyPipeLike = PipeLike<any, any>;

export type AnyPipe = Pipe<any, any>;

export type InputOfPipe<P extends AnyPipeLike> = P extends PipeLike<
    infer I,
    any
>
    ? I
    : never;

export type OutputOfPipe<P extends AnyPipeLike> = P extends PipeLike<
    any,
    infer O
>
    ? O
    : never;

type Subscriber<O> = (output: O) => void | Promise<void>;

export class Pipe<I, O> {
    private constructor(
        private pipeFunctions: PipeFunction<any, any>[] = [],
        private eventChannel = new EventEmitter()
    ) {}

    public static passThrough<I = unknown>(): Pipe<I, I> {
        return Pipe.from((input, control) => control.next(input));
    }

    public static from<I, O>(pipeFunction: PipeFunction<I, O>): Pipe<I, O> {
        assertIsPipeLike(pipeFunction);

        return new Pipe([pipeFunction]);
    }

    public extend<P extends PipeLike<I, any>>(
        pipeLike: P
    ): Pipe<I, OutputOfPipe<P>> {
        assertIsPipeLike(pipeLike);

        const newPipe = this.clone();
        newPipe.copyPipeFunctionsFrom(pipeLike);
        return newPipe;
    }

    private copyPipeFunctionsFrom(pipeLike: AnyPipeLike): void {
        if (pipeLike instanceof Pipe) {
            this.pipeFunctions.push(...pipeLike.pipeFunctions);
        } else {
            this.pipeFunctions.push(pipeLike);
        }
    }

    public async send(payload: I): Promise<void> {
        let finalResult: any;

        await chainFunctions(this.pipeFunctions, (result) => {
            finalResult = result;
        })(payload);

        this.eventChannel.emit("finalResult", finalResult);
    }

    public subscribe(
        subscriber: O extends never | undefined ? never : Subscriber<O>
    ): void {
        this.eventChannel.on("finalResult", subscriber);
    }

    public clone(): Pipe<I, O> {
        const newPipe = new Pipe();
        newPipe.pipeFunctions = [...this.pipeFunctions];
        return newPipe;
    }
}

export function isPipeLike(pipe: unknown): pipe is AnyPipeLike {
    return pipe instanceof Pipe || typeof pipe === "function";
}

function assertIsPipeLike(pipe: unknown): asserts pipe is AnyPipeLike {
    if (!isPipeLike(pipe)) {
        throw new Error(
            `Cannot create a pipe from '${pipe}'. It is not a function.`
        );
    }
}

function chainFunctions(
    fnList: PipeFunction[],
    receiveFinalOutput: (value: any) => void
): (input: any) => Promise<void> {
    return async function chain(input, index = 0) {
        if (index < fnList.length) {
            const next = (output: any) => chain(output, index + 1);
            await fnList[index](input, {
                next,
            });
        } else {
            receiveFinalOutput(input);
        }
    };
}
