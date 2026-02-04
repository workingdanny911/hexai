export default {
    contracts: {
        contexts: [
            {
                name: "assignment",
                path: "packages/assignment",
                responseNamingConventions: [
                    { messageSuffix: "Command", responseSuffix: "Result" },
                ],
            },
        ],
        responseNamingConventions: [
            { messageSuffix: "Request", responseSuffix: "Response" },
        ],
    },
};
