import { beforeEach, describe, it, test, vi } from "vitest";

import { ValidationError } from "@/domain";
import {
    expectUnknownErrorResponse,
    expectValidationErrorResponse,
} from "@/test";

import { UseCase } from "./use-case";

class DummyUseCase extends UseCase<{}> {
    protected async doHandle() {}
}

describe("use case", () => {
    const useCase = new DummyUseCase();

    beforeEach(() => {
        vi.restoreAllMocks();
    });

    function throwInHandler(error: Error) {
        vi.spyOn(useCase as any, "doHandle").mockRejectedValue(error);
    }

    function patch(impl: any) {
        // @ts-ignore
        vi.spyOn(useCase, "doHandle").mockImplementation(impl);
    }

    it("catches error thrown in execution body and transforms to error response", async () => {
        throwInHandler(new Error("Something went wrong"));

        const response = await useCase.handle({});

        expectUnknownErrorResponse(response, "Something went wrong");
    });

    test("when ValidationError thrown", async () => {
        throwInHandler(new ValidationError("field", "error-code"));

        const response = await useCase.handle({});

        expectValidationErrorResponse(response, {
            field: "error-code",
        });
    });
});
