import { beforeEach, describe, expect, test } from "vitest";

import {
    AggregateRoot,
    DuplicateObjectError,
    EntityId,
    ObjectNotFoundError,
} from "@/domain";
import {
    DummyMessage,
    expectEventsPublishedToEqual,
    InMemoryDatabaseConcerns,
} from "@/test";
import {
    Counter,
    CounterId,
    CounterRepository,
} from "src/test/fixtures/counter-example";

const dbConcerns = new InMemoryDatabaseConcerns();
const unitOfWork = dbConcerns.asUnitOfWork();
const repository = dbConcerns.createRepository<CounterRepository>({
    namespace: "counter",
    hydrate: (memento) => Counter.fromMemento(memento),
    dehydrate: (entity) => entity.toMemento(),
});
const eventTracker = dbConcerns.createPublishedEventTracker();
const eventPublisher = dbConcerns.createOutboxEventPublisher();
const consumedMessageTracker = dbConcerns.createConsumedMessageTracker();

beforeEach(() => {
    dbConcerns.clear();
});

function createCounter(id: string): Counter {
    return Counter.create(CounterId.from(id));
}

describe("repository", () => {
    test("creating a new entity", async () => {
        const entity = createCounter("id");

        await repository.add(entity);

        const storedEntity = await repository.get(CounterId.from("id"));
        expect(storedEntity.equals(entity)).toBe(true);
    });

    test("trying to create an entity that already exists", async () => {
        const entity = createCounter("id");

        await repository.add(entity);

        await expect(repository.add(entity)).rejects.toThrowError(
            DuplicateObjectError
        );
    });

    test("updating an entity", async () => {
        const entity = createCounter("id");

        await repository.add(entity);

        entity.increment();
        await repository.update(entity);

        const storedEntity = await repository.get(CounterId.from("id"));
        expect(storedEntity.equals(entity)).toBe(true);
    });

    test("counting entities", async () => {
        const entity = createCounter("id");
        const entity2 = createCounter("id2");

        await repository.add(entity);
        expect(await repository.count()).toEqual(1);

        await repository.add(entity2);
        expect(await repository.count()).toEqual(2);
    });

    test("getting an entity that does not exist", async () => {
        await expect(
            repository.get(CounterId.from("non-existing-id"))
        ).rejects.toThrowError(ObjectNotFoundError);
    });

    test("rolling back", async () => {
        const entity = createCounter("id");

        await expect(
            unitOfWork.wrap(async () => {
                await repository.add(entity);
                throw new Error("rollback");
            })
        ).rejects.toThrow("rollback");

        await expect(repository.get(CounterId.from("id"))).rejects.toThrowError(
            ObjectNotFoundError
        );
    });

    class GenericEntityId extends EntityId<string> {}

    class EntityA extends AggregateRoot<GenericEntityId> {
        public static create(id: GenericEntityId): EntityA {
            return new EntityA(id);
        }
    }

    class EntityB extends AggregateRoot<GenericEntityId> {
        public static create(id: GenericEntityId): EntityB {
            return new EntityB(id);
        }
    }

    test("multiple repositories", async () => {
        const aRepository = dbConcerns.createRepository({
            namespace: "a-entities",
            hydrate: ({ id }) => EntityA.create(GenericEntityId.from(id)),
            dehydrate: (entity) => ({ id: entity.getId().getValue() }),
        });
        const bRepository = dbConcerns.createRepository({
            namespace: "b-entities",
            hydrate: ({ id }) => EntityB.create(GenericEntityId.from(id)),
            dehydrate: (entity) => ({ id: entity.getId().getValue() }),
        });

        await aRepository.add(EntityA.create(GenericEntityId.from("id")));
        await bRepository.add(EntityB.create(GenericEntityId.from("id")));

        await expect(aRepository.count()).resolves.toEqual(1);
        await expect(bRepository.count()).resolves.toEqual(1);

        const a = await aRepository.get(GenericEntityId.from("id"));
        const b = await bRepository.get(GenericEntityId.from("id"));

        expect(a).toBeInstanceOf(EntityA);
        expect(b).toBeInstanceOf(EntityB);
    });
});

describe("event publisher and tracker", () => {
    test("publishing events", async () => {
        const events = DummyMessage.createMany(5);

        await eventPublisher.publish(...events);

        await expectEventsPublishedToEqual(eventTracker, events);

        await eventPublisher.publish(...events);

        await expectEventsPublishedToEqual(eventTracker, [
            ...events,
            ...events,
        ]);
    });

    test("marking events as published", async () => {
        const events = DummyMessage.createMany(5);

        await eventPublisher.publish(...events);
        await eventTracker.markMessagesAsPublished(1, 5);

        await expectEventsPublishedToEqual(eventTracker, []);
    });

    test("rolling back", async () => {
        const events = DummyMessage.createMany(5);

        await expect(
            unitOfWork.wrap(async () => {
                await eventPublisher.publish(...events);
                throw new Error("rollback");
            })
        ).rejects.toThrow("rollback");

        await expectEventsPublishedToEqual(eventTracker, []);
    });
});

describe("consumed event tracker", () => {
    test("marking event as consumed", async () => {
        const event = DummyMessage.create();

        await consumedMessageTracker.markAsConsumed("consumer-name", event);

        expect(
            consumedMessageTracker.markAsConsumed("consumer-name", event)
        ).rejects.toThrowError(Error);
    });

    test("rolling back", async () => {
        const event = DummyMessage.create();

        await expect(
            unitOfWork.wrap(async () => {
                await consumedMessageTracker.markAsConsumed(
                    "consumer-name",
                    event
                );
                throw new Error("rollback");
            })
        ).rejects.toThrow("rollback");

        await expect(
            consumedMessageTracker.markAsConsumed("consumer-name", event)
        ).resolves.toBeUndefined();
    });
});

describe("transactional behavior", () => {
    test("all roles share the same transaction", async () => {
        const entity = Counter.create(CounterId.from("id"));
        const event = DummyMessage.create();

        await unitOfWork.wrap(async () => {
            await repository.add(entity);
            await eventPublisher.publish([event]);
            await eventTracker.markMessagesAsPublished(1, 1);
            await consumedMessageTracker.markAsConsumed("consumer-name", event);

            await expect(
                unitOfWork.wrap(async () => {
                    throw new Error("rollback");
                })
            ).rejects.toThrow("rollback");
        });

        await expect(repository.get(CounterId.from("id"))).rejects.toThrowError(
            ObjectNotFoundError
        );
        await expectEventsPublishedToEqual(eventTracker, []);
        await expect(
            consumedMessageTracker.markAsConsumed("consumer-name", event)
        ).resolves.toBeUndefined();
    });
});
