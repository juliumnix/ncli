export const DEMO_3D_SOURCE = `ncli3d.desk()`;
export const DEMO_3D_BOX_SOURCE = `ncli3d.box()`;

export function demo3dFence(): string {
  return `\`\`\`ncli 3d\n${DEMO_3D_SOURCE}\n\`\`\``;
}

export function demo3dBoxFence(): string {
  return `\`\`\`ncli 3d\n${DEMO_3D_BOX_SOURCE}\n\`\`\``;
}

export const DEMO_3D_GRAPH_SOURCE = `ncli3d.graph({nodes:[{id:"hub",label:"Hub"},{id:"ui",label:"Cockpit"}],edges:[["hub","ui"]],layers:[["hub"],["ui"]]})`;

export function demo3dGraphFence(): string {
  return `\`\`\`ncli 3d\n${DEMO_3D_GRAPH_SOURCE}\n\`\`\``;
}
