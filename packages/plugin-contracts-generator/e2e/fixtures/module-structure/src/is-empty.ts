export function isEmpty(value: any) {
    return (
        value === undefined ||
        value === null ||
        (typeof value === "object" && Object.keys(value).length === 0)
    );
}
