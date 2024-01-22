import { IdempotencySupport } from "@/endpoint";

export interface IdempotencySupportHolder {
    getIdempotencySupport(): IdempotencySupport;
}
