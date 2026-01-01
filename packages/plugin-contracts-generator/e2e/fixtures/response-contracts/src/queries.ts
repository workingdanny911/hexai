import { Message } from "@hexaijs/core";

import { PublicQuery } from "@/decorators";

import { UserId, LectureId } from "./types";

// Case 1: Naming convention matching (Query → QueryResult)
@PublicQuery()
export class GetLectureQuery extends Message<{
    lectureId: LectureId;
}> {}

// Non-exported interface - should be automatically exported when matched
interface GetLectureQueryResult {
    lectureId: LectureId;
    title: string;
    instructorId: UserId;
    createdAt: Date;
}

// Case 2: Explicit response option with interface
@PublicQuery({ response: "LectureListResponse" })
export class ListLecturesQuery extends Message<{
    instructorId?: UserId;
    page: number;
    limit: number;
}> {}

// Explicit response type - should be exported
interface LectureListResponse {
    lectures: Array<{
        lectureId: LectureId;
        title: string;
    }>;
    total: number;
    page: number;
}
