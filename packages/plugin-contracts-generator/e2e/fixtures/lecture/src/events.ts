import { Message } from "@hexaijs/core";

import { PublicEvent } from "@/decorators";

import { BasePayload, LectureId } from "./types";

@PublicEvent()
export class LectureCreated extends Message<
    BasePayload & {
        lectureId: LectureId;
        title: string;
    }
> {}

@PublicEvent()
export class LectureDeleted extends Message<{
    lectureId: LectureId;
}> {}
