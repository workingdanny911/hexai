import { Message } from "@hexaijs/core";
import type { LectureId, InstructorId } from "./types";
import { LessonCredit, LessonPrice } from "./domain";
import { PublicCommand } from "@/decorators";

@PublicCommand()
export class CreateLecture extends Message<{
    lectureId: LectureId;
    instructorId: InstructorId;
    title: string;
    credit: number;
    price: number;
}> {
    validate() {
        const credit = new LessonCredit(this.payload.credit);
        const price = new LessonPrice(this.payload.price, "KRW");

        return {
            ...this.payload,
            credit,
            price,
        };
    }
}
