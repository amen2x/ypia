const uploadButton = document.getElementById("openUploadModal");

if (uploadButton instanceof HTMLButtonElement) {
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".jpg,.jpeg,.png,.pdf";
  fileInput.hidden = true;
  document.body.append(fileInput);

  const results = document.createElement("section");
  results.hidden = true;
  results.setAttribute("aria-live", "polite");
  uploadButton.closest("nav")?.insertAdjacentElement("afterend", results);

  const renderList = (title, entries) => {
    if (entries.length === 0) return;
    const heading = document.createElement("h2");
    heading.textContent = title;
    const list = document.createElement("ul");
    entries.forEach((entry) => {
      const item = document.createElement("li");
      item.textContent = entry;
      list.append(item);
    });
    results.append(heading, list);
  };

  const showResult = (documentResult) => {
    results.replaceChildren();
    results.hidden = false;

    const heading = document.createElement("h2");
    heading.textContent = "Document results";
    const documentType = document.createElement("p");
    documentType.textContent = `Document type: ${documentResult.documentType}`;
    results.append(heading, documentType);

    renderList("Medications", documentResult.medications.map((medication) => {
      const rxNormName = medication.rxnorm.normalizedName ? `; RxNorm: ${medication.rxnorm.normalizedName}` : "";
      return `${medication.name}; dose: ${medication.dose ?? "not provided"}; frequency: ${medication.frequency ?? "not provided"}${rxNormName}`;
    }));
    renderList("Appointments", documentResult.appointments.map((appointment) =>
      `${appointment.type ?? "Appointment"}; provider: ${appointment.provider ?? "not provided"}; date: ${appointment.date ?? "not provided"}; time: ${appointment.time ?? "not provided"}; location: ${appointment.location ?? "not provided"}`
    ));
    renderList("Follow-ups", documentResult.followUps.map((followUp) =>
      `${followUp.description}; timeframe: ${followUp.timeframe ?? "not provided"}`
    ));
    renderList("Instructions", documentResult.instructions);
  };

  const showError = () => {
    results.replaceChildren();
    results.hidden = false;
    const message = document.createElement("p");
    message.textContent = "We couldn't process that document. Please try again.";
    results.append(message);
  };

  const restoreButton = () => {
    uploadButton.disabled = false;
    uploadButton.textContent = "Upload Documents";
  };

  uploadButton.addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", async () => {
    const selectedFile = fileInput.files?.[0];
    if (!selectedFile) return;

    uploadButton.disabled = true;
    uploadButton.textContent = "Processing...";
    const formData = new FormData();
    formData.append("document", selectedFile);

    try {
      const response = await fetch("/api/documents", {
        method: "POST",
        body: formData
      });
      if (!response.ok) throw new Error(`Upload failed with status ${response.status}`);
      showResult(await response.json());
    } catch (error) {
      console.error("Document upload failed", error);
      showError();
    } finally {
      fileInput.value = "";
      restoreButton();
    }
  });
}
