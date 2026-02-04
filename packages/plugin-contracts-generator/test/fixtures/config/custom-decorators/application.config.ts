export default {
    contracts: {
        contexts: [
            {
                name: "order",
                path: ".",
            },
        ],
        decoratorNames: {
            event: "ContractEvent",
            command: "ContractCommand",
            query: "ContractQuery",
        },
    },
};
