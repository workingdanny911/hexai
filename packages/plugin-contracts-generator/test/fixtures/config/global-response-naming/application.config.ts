export default {
    contracts: {
        contexts: [
            {
                name: "lecture",
                sourceDir: "src",
            },
        ],
        responseNamingConventions: [
            { messageSuffix: "Request", responseSuffix: "Response" },
            { messageSuffix: "Command", responseSuffix: "CommandResult" },
        ],
    },
};
