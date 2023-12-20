import { UnitOfWorkHolder } from "Hexai/helpers";
import { Command } from "Hexai/message";
import { Factory } from "Hexai/utils";
import { UseCase } from "./use-case";

export type UseCaseFactory<
    Ctx extends UnitOfWorkHolder,
    Req extends Command = Command,
    Res = unknown,
> = Factory<[Ctx], UseCase<Req, Res, Ctx>>;
