"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.IncreaseCounter = exports.IncreaseCounterRequest = exports.CreateCounter = exports.CreateCounterRequest = exports.CounterValueChanged = exports.CounterCreated = exports.Counter = exports.CounterId = void 0;
const domain_1 = require("../domain");
const application_1 = require("../application");
const message_1 = require("../message");
class CounterId extends domain_1.EntityId {
}
exports.CounterId = CounterId;
class Counter extends domain_1.AggregateRoot {
    value = 0;
    static create(id) {
        const counter = new Counter(id);
        counter.raiseCreated();
        return counter;
    }
    raiseCreated() {
        this.raise(new CounterCreated({ id: this.getId() }));
    }
    constructor(id, value) {
        super(id);
        this.value = value ?? 0;
    }
    increment(by = 1) {
        this.value += by;
        this.raiseValueChange();
    }
    decrement(by = 1) {
        this.value -= by;
        this.raiseValueChange();
    }
    raiseValueChange() {
        this.raise(new CounterValueChanged({ id: this.getId(), value: this.value }));
    }
    static fromMemento(memento) {
        return new Counter(CounterId.from(memento.id), memento.value);
    }
    toMemento() {
        return {
            id: this.getId().getValue(),
            value: this.value,
        };
    }
    getValue() {
        return this.value;
    }
    equals(other) {
        return (this.constructor === other.constructor &&
            this.getId().equals(other.getId()) &&
            this.getValue() === other.getValue());
    }
}
exports.Counter = Counter;
class CounterCreated extends message_1.Message {
    static type = "test.counter.counter-created";
    static deserializeRawPayload(rawPayload) {
        return {
            id: CounterId.from(rawPayload.id),
        };
    }
    serializePayload(payload) {
        return {
            id: payload.id.getValue(),
        };
    }
}
exports.CounterCreated = CounterCreated;
class CounterValueChanged extends message_1.Message {
    static type = "test.counter.counter-value-changed";
    static deserializeRawPayload(rawPayload) {
        return {
            id: CounterId.from(rawPayload.id),
            value: rawPayload.value,
        };
    }
    serializePayload(payload) {
        return {
            id: payload.id.getValue(),
            value: payload.value,
        };
    }
}
exports.CounterValueChanged = CounterValueChanged;
class CreateCounterRequest extends message_1.Message {
    id;
    constructor(id) {
        super({
            id,
        });
        this.id = id;
    }
}
exports.CreateCounterRequest = CreateCounterRequest;
class CreateCounter extends application_1.UseCase {
    async doExecute(request) {
        const repository = this.applicationContext.getCounterRepository();
        const counter = Counter.create(CounterId.from(request.id));
        await repository.add(counter);
        await this.eventPublisher.publish(counter.collectEvents());
    }
}
exports.CreateCounter = CreateCounter;
__decorate([
    (0, application_1.Atomic)(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [CreateCounterRequest]),
    __metadata("design:returntype", Promise)
], CreateCounter.prototype, "doExecute", null);
class IncreaseCounterRequest extends message_1.Message {
    id;
    constructor(id) {
        super({
            id,
        });
        this.id = id;
    }
}
exports.IncreaseCounterRequest = IncreaseCounterRequest;
class IncreaseCounter extends application_1.UseCase {
    async doExecute(request) {
        const repository = this.applicationContext.getCounterRepository();
        const counter = await repository.get(CounterId.from(request.id));
        counter.increment();
        await repository.update(counter);
        await this.eventPublisher.publish(counter.collectEvents());
        return {
            value: counter.getValue(),
        };
    }
    static errorToResponse(error) {
        if (error instanceof domain_1.ObjectNotFoundError) {
            return (0, application_1.validationErrorResponse)({
                id: "NOT_FOUND",
            });
        }
    }
}
exports.IncreaseCounter = IncreaseCounter;
__decorate([
    (0, application_1.Atomic)(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [IncreaseCounterRequest]),
    __metadata("design:returntype", Promise)
], IncreaseCounter.prototype, "doExecute", null);
//# sourceMappingURL=counter-example.js.map