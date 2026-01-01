import { Message } from "@hexaijs/core";

import { PublicCommand } from "@/decorators";

import { UserId, LectureId } from "./types";

// Case 1: Naming convention matching (Command → Result)
// CreateLectureCommand should automatically match CreateLectureResult
@PublicCommand()
export class CreateLectureCommand extends Message<{
    title: string;
    instructorId: UserId;
}> {}

// Non-exported type - should be automatically exported when matched
type CreateLectureResult = {
    lectureId: LectureId;
    createdAt: Date;
};

// Case 2: Explicit response option
// Using explicit response option to specify the result type
@PublicCommand({ response: "DeleteLectureResponse" })
export class DeleteLectureCommand extends Message<{
    lectureId: LectureId;
}> {}

// This type is explicitly referenced, should be exported
type DeleteLectureResponse = {
    success: boolean;
    deletedAt: Date;
};

// Case 3: Already exported type - should remain as is
@PublicCommand()
export class UpdateLectureCommand extends Message<{
    lectureId: LectureId;
    title: string;
}> {}

// Already exported type - no changes needed
export type UpdateLectureResult = {
    lectureId: LectureId;
    updatedAt: Date;
};

// Case 4: No matching response type - should be ignored (valid case)
@PublicCommand()
export class PublishLectureCommand extends Message<{
    lectureId: LectureId;
}> {}
