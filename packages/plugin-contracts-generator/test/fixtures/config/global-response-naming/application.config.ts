export default {
    contracts: {
        contexts: [
            {
                name: "lecture",
                path: ".",
            },
        ],
        responseNamingConventions: [
            { messageSuffix: "Request", responseSuffix: "Response" },
            { messageSuffix: "Command", responseSuffix: "CommandResult" },
        ],
    },
};
