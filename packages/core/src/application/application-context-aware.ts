export interface ApplicationContextAware<C extends object = object> {
    setApplicationContext(context: C): void;
}
