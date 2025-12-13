export type IsoDateString = string;

export type ProjectId = string;

export type Project = {
  id: ProjectId;
  path: string;
  name: string;
  createdAt: IsoDateString;
  lastUsedAt?: IsoDateString;
};

export type SessionRecord = {
  name: string; // tmux session name
  projectId: ProjectId;
  projectPath: string;
  createdAt: IsoDateString;
  command?: string; // original user command string (bash -c)
  lastAttachedAt?: IsoDateString;
};

export type StateV1 = {
  version: 1;
  projects: Record<ProjectId, Project>;
  sessions: Record<string, SessionRecord>;
};

