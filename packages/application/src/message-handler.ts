export interface MessageHandler<M = any, R = any, C = any> {
    execute(message: M, ctx?: C): R;
}
