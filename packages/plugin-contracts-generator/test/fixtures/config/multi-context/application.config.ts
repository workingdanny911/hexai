export default {
    contracts: {
        contexts: [
            {
                name: "lecture",
                sourceDir: "packages/lecture/src",
            },
            {
                name: "video-lesson",
                sourceDir: "packages/video-lesson/src",
            },
        ],
        pathAliasRewrites: {
            "@/decorators": "@libera/decorators",
            "@/types": "@libera/types",
        },
    },
};
