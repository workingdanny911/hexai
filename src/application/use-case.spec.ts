import { beforeEach, describe, it, test, vi } from "vitest";

import { UseCase } from "Hexai/application";
import { ValidationError } from "Hexai/domain";
import { Command } from "Hexai/message";
import {
    expectUnknownErrorResponse,
    expectValidationErrorResponse,
} from "Hexai/test";

class DummyUseCaseRequest extends Command {
    constructor() {
        super({});
    }
}

class DummyUseCase extends UseCase<DummyUseCaseRequest> {
    protected async doExecute() {}
}

describe("use case", () => {
    const useCase = new DummyUseCase({} as any);

    beforeEach(() => {
        vi.restoreAllMocks();
    });

    function patch(impl: any) {
        // @ts-ignore
        vi.spyOn(useCase, "doExecute").mockImplementation(impl);
    }

    it("catches error thrown in execution body and transforms to error response", async () => {
        patch(() => {
            throw new Error("Something went wrong");
        });

        const response = await useCase.execute(new DummyUseCaseRequest());

        expectUnknownErrorResponse(response, "Something went wrong");
    });

    test("when ValidationError thrown", async () => {
        patch(() => {
            throw new ValidationError("field", "code", "message");
        });

        const response = await useCase.execute(new DummyUseCaseRequest());

        expectValidationErrorResponse(response, {
            field: "code",
        });
    });
});
