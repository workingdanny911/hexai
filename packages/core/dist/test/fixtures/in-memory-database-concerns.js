"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.InMemoryRepository = void 0;
const node_async_hooks_1 = require("node:async_hooks");
const lodash_1 = __importDefault(require("lodash"));
const domain_1 = require("../../domain");
class InMemoryDatabaseConcerns {
    state = emptyState();
    transactionStore = new node_async_hooks_1.AsyncLocalStorage();
    constructor() {
        this.clear();
    }
    async wrap(fn) {
        const current = this.transactionStore.getStore();
        if (!current) {
            return this.wrapWithNew(fn);
        }
        try {
            return await fn();
        }
        catch (e) {
            current.transactionStatus = "closed";
            throw e;
        }
    }
    async wrapWithNew(fn) {
        const temporalState = lodash_1.default.cloneDeep(this.state);
        const result = await this.transactionStore.run(temporalState, fn);
        if (temporalState.transactionStatus === "open") {
            this.state = lodash_1.default.merge(this.state, temporalState);
        }
        return result;
    }
    getClient() {
        return undefined;
    }
    asUnitOfWork() {
        return this;
    }
    createRepository({ namespace, hydrate, dehydrate, }, clazz) {
        const getState = this.makeGetState(namespace);
        if (clazz) {
            return new clazz(getState, {
                namespace,
                hydrate,
                dehydrate,
            });
        }
        return new InMemoryRepository(getState, {
            namespace,
            hydrate,
            dehydrate,
        });
    }
    createOutboxEventPublisher() {
        return new InMemoryOutboxPublisher(this.makeGetState());
    }
    createPublishedEventTracker() {
        return new InMemoryPublishedEventTracker(this.makeGetState());
    }
    createConsumedMessageTracker() {
        return new InMemoryConsumedMessageTracker(this.makeGetState());
    }
    makeGetState(entityNamespace) {
        return () => {
            const state = this.transactionStore.getStore() || this.state;
            if (entityNamespace && !state[entityNamespace]) {
                state[entityNamespace] = {};
            }
            return new Proxy(state, {
                set: (target, property, value) => {
                    if (target.transactionStatus === "closed") {
                        throw new Error("transaction already closed, cannot mutate state");
                    }
                    target[property] = value;
                    return true;
                },
                get: (target, property) => {
                    if (property === "transactionStatus") {
                        return target.transactionStatus;
                    }
                    if (target.transactionStatus === "closed") {
                        throw new Error("transaction already closed, cannot mutate state");
                    }
                    return target[property];
                },
            });
        };
    }
    clear() {
        this.state = emptyState();
    }
}
exports.default = InMemoryDatabaseConcerns;
function emptyState() {
    return {
        transactionStatus: "open",
        events: [],
        unpublishedFrom: 1,
        consumedMessages: {},
    };
}
class InMemoryRepository {
    getState;
    namespace;
    hydrate;
    dehydrate;
    constructor(getState, { hydrate, dehydrate, namespace, }) {
        this.getState = getState;
        this.hydrate = hydrate;
        this.dehydrate = dehydrate;
        this.namespace = namespace;
    }
    async add(entity) {
        const id = entity.getId().getValue();
        if (this.getEntities()[id]) {
            throw new domain_1.DuplicateObjectError(`entity with id '${id}' already exists`);
        }
        this.save(entity);
    }
    async update(entity) {
        const id = entity.getId().getValue();
        if (!this.getEntities()[id]) {
            throw new domain_1.ObjectNotFoundError(`entity with id '${id}' not found`);
        }
        this.save(entity);
    }
    save(entity) {
        this.getEntities()[entity.getId().getValue()] = this.dehydrate(entity);
    }
    async get(id) {
        const raw = this.getEntities()[id.getValue()];
        if (!raw) {
            throw new domain_1.ObjectNotFoundError(`entity with id '${id.getValue()}' not found`);
        }
        return this.hydrate(raw);
    }
    async count() {
        return Object.keys(this.getEntities()).length;
    }
    getEntities() {
        return this.getState()[this.namespace];
    }
}
exports.InMemoryRepository = InMemoryRepository;
class InMemoryOutboxPublisher {
    getState;
    constructor(getState) {
        this.getState = getState;
    }
    async publish(...events) {
        this.getState().events.push(...events);
    }
}
class InMemoryPublishedEventTracker {
    getState;
    constructor(getState) {
        this.getState = getState;
    }
    async getUnpublishedMessages(batchSize) {
        return [
            this.getState().unpublishedFrom,
            this.getState().events.slice(this.getState().unpublishedFrom - 1, batchSize),
        ];
    }
    async markMessagesAsPublished(fromPosition, numEvents) {
        this.getState().unpublishedFrom = fromPosition + numEvents;
    }
}
class InMemoryConsumedMessageTracker {
    getState;
    constructor(getState) {
        this.getState = getState;
    }
    async markAsConsumed(name, event) {
        if (!this.getState().consumedMessages[name]) {
            this.getState().consumedMessages[name] = new Set();
        }
        const eventSet = this.getState().consumedMessages[name];
        const eid = event.getMessageId();
        if (eventSet.has(eid)) {
            throw new Error(`Event '${event.getMessageId()}' is already consumed`);
        }
        eventSet.add(eid);
    }
}
//# sourceMappingURL=in-memory-database-concerns.js.map