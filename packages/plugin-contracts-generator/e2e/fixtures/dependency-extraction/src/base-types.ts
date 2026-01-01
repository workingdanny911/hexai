// Base type that will be extended by a local interface
export interface BaseProfile {
    id: string;
    name: string;
    createdAt: string;
}

// Utility function that will be called in method body
export function generateId(prefix: string): string {
    return `${prefix}-${Date.now()}`;
}

// Another utility for testing multiple function calls
export function formatDate(date: Date): string {
    return date.toISOString();
}
