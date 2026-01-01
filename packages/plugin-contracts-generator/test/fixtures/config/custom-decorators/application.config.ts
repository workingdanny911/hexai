export default {
    contracts: {
        contexts: [
            {
                name: "order",
                sourceDir: "src",
            },
        ],
        decoratorNames: {
            event: "ContractEvent",
            command: "ContractCommand",
            query: "ContractQuery",
        },
    },
};
