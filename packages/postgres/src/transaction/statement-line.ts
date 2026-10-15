/**
 * Sends a transaction's statements to its connection one at a time, in the
 * order they were queued. Each statement settles on its own, so a failure
 * does not hold up the statements behind it. pg's own queue for overlapping
 * queries is deprecated, so the connection never gets two at once.
 *
 * The line keeps its own promise of each turn. The promise a caller receives
 * has no handler attached here, so a rejection nobody handles still surfaces.
 */
export class StatementLine {
    private lastTurn: Promise<void> = Promise.resolve();
    private turnsInLine = 0;

    enqueue<T>(send: () => Promise<T>): Promise<T> {
        const previousTurn = this.lastTurn;
        const endTurn = this.takeTurn();
        return previousTurn.then(async () => {
            try {
                return await send();
            } finally {
                endTurn();
            }
        });
    }

    // Like enqueue(), but an empty line starts `send` within this call, as pg
    // hands a query to an idle connection within query().
    enqueueOrStart(send: () => Promise<void>): Promise<void> {
        if (this.turnsInLine > 0) {
            return this.enqueue(send);
        }
        const endTurn = this.takeTurn();
        return send().finally(endTurn);
    }

    private takeTurn(): () => void {
        this.turnsInLine += 1;
        let endTurn!: () => void;
        this.lastTurn = new Promise<void>((resolve) => {
            endTurn = resolve;
        });
        return () => {
            this.turnsInLine -= 1;
            endTurn();
        };
    }
}
