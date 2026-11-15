const SECRET_VARIABLES = ['OPENAI_API_KEY', 'GROQ_API_KEY'];

export function childEnvironment(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const name of SECRET_VARIABLES) delete env[name];
  return env;
}
