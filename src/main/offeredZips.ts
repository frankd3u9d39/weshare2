// fileId -> temp zip path, shared between file selection (which creates the zip when a
// folder is offered) and native transfer (which cleans it up once the send completes).
export const offeredFolderZips = new Map<string, string>();
