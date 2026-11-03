// Windows Script Host JScript: export a DOCX to PDF through Microsoft Word.
// Usage: cscript //nologo render_docx_with_word.js input.docx output.pdf

if (WScript.Arguments.length !== 2) {
    WScript.Echo("usage: render_docx_with_word.js input.docx output.pdf");
    WScript.Quit(2);
}

var inputPath = WScript.Arguments.Item(0);
var outputPath = WScript.Arguments.Item(1);
var word = null;
var document = null;

try {
    word = new ActiveXObject("Word.Application");
    word.Visible = false;
    word.DisplayAlerts = 0;
    document = word.Documents.Open(inputPath, false, true, false);
    // 17 is wdFormatPDF.
    document.SaveAs2(outputPath, 17);
    document.Close(false);
    document = null;
    word.Quit();
    word = null;
    WScript.Echo(outputPath);
} catch (error) {
    if (document !== null) {
        try { document.Close(false); } catch (ignoredDocumentError) {}
    }
    if (word !== null) {
        try { word.Quit(); } catch (ignoredWordError) {}
    }
    WScript.Echo("Word export failed: " + error.message);
    WScript.Quit(1);
}
