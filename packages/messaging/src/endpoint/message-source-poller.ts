import { Lifecycle } from "@/lifecycle";

export interface MessageSourcePoller extends Lifecycle {
    onPoll(callback: () => Promise<void>): void;
}
