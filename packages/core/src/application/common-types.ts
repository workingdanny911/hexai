import { UnitOfWorkHolder } from "@/helpers";
import { Factory } from "@/utils";
import { UseCase } from "./use-case";

import { Command } from "@/message";

export type UseCaseFactory<
    Ctx extends UnitOfWorkHolder,
    Req extends Command = Command,
    Res = unknown,
> = Factory<[Ctx], UseCase<Req, Res, Ctx>>;
