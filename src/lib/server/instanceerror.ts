/** A refusal to show as it is (a 400 with its message), not a crash. Here so modloaders.ts can throw it without importing instances.ts. */
export class InstanceError extends Error {}
