export const DEMO_3D_SOURCE = `ncli3d.desk()`;
export const DEMO_3D_BOX_SOURCE = `ncli3d.box()`;

export function demo3dFence(): string {
  return `\`\`\`ncli 3d\n${DEMO_3D_SOURCE}\n\`\`\``;
}

export function demo3dBoxFence(): string {
  return `\`\`\`ncli 3d\n${DEMO_3D_BOX_SOURCE}\n\`\`\``;
}
