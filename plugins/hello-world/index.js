export const tool = {
  name: 'hello_plugin',
  description: 'A test plugin tool. Returns a greeting.',
  parameterDescription: 'name (optional): Who to greet.',
  category: 'test',
  async execute(params) {
    return `Hello from the plugin system! Greeting ${params.name ?? 'world'}.`;
  }
};
