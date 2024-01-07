import { beforeEach, describe, it, test, vi } from "vitest";

import { ValidationError } from "@/domain";
import {
    expectUnknownErrorResponse,
    expectValidationErrorResponse,
} from "@/test";

import { UseCase } from "./use-case";

class DummyUseCase extends UseCase<{}> {
    protected async doExecute() {}
}

describe("use case", () => {
    const useCase = new DummyUseCase();

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

        const response = await useCase.execute({});

        expectUnknownErrorResponse(response, "Something went wrong");
    });

    test("when ValidationError thrown", async () => {
        patch(() => {
            throw new ValidationError("field", "code", "message");
        });

        const response = await useCase.execute({});

        expectValidationErrorResponse(response, {
            field: "code",
        });
    });
});
