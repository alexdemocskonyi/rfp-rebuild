//app/uploadFix.js

export async function uploadFile(file) {
  const formData = new FormData();
  formData.append("file", file);
  const res = await fetch("/api/ingest", {
    method: "POST",
    body: formData
  });
  return res.json();
}
