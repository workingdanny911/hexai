import { Message } from "@hexaijs/core";

import { PublicCommand } from "@/decorators";

import { UserId } from "./types";

@PublicCommand()
export class CreateLecture extends Message<{
    title: string;
    instructorId: UserId;
}> {}
