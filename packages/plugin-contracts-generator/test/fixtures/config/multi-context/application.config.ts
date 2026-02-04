export default {
    contracts: {
        contexts: [
            {
                name: "lecture",
                path: "packages/lecture",
            },
            {
                name: "video-lesson",
                path: "packages/video-lesson",
            },
        ],
        pathAliasRewrites: {
            "@/decorators": "@libera/decorators",
            "@/types": "@libera/types",
        },
    },
};
