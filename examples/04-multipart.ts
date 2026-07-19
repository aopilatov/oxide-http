// Загрузка файлов (§9a): парсинг в Rust потоково, лимиты и типы проверяются
// ДО передачи файла в JS — мусорный запрос обрывается на краю.
import { Server } from '../js/index.ts';

const app = new Server();

app.post(
  '/upload',
  {
    multipart: {
      maxFileSize: '20mb',
      maxFiles: 3,
      allowedMimeTypes: ['image/*', 'application/pdf'],
      allowedExtensions: ['.png', '.jpg', '.pdf'],
    },
  },
  async (c) => {
    const files: Array<{ name?: string; filename?: string; bytes: number }> = [];
    const fields: Record<string, string> = {};

    for await (const part of c.req.parts()) {
      if (part.filename != null) {
        // Потоково: файл не оседает в памяти целиком.
        let bytes = 0;
        for await (const chunk of part.stream) bytes += chunk.length;
        files.push({ name: part.name, filename: part.filename, bytes });
      } else {
        fields[part.name ?? ''] = await part.text();
      }
    }
    return c.json({ files, fields });
  },
);

// Сахар: если файлы небольшие, можно взять готовую FormData.
app.post('/form', { multipart: true }, async (c) => {
  const fd = await c.req.formData();
  return c.json({ keys: [...fd.keys()] });
});

await app.listen({ port: 3003 });
console.log('http://127.0.0.1:3003');
