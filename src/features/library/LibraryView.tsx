import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { db, type DocumentItem } from '../../db/db';
import { useAppStore } from '../../store/useAppStore';
import { getLanguagePack } from '../../packs/registry';
import { parseUploadedFile } from '../reader/fileParsers';
import { logEvent } from '../../core/eventLogger';
import {
  BookOpen,
  Plus,
  Upload,
  FileText,
  Trash2,
  Search,
  Sparkles,
  CheckCircle,
  FileCode,
  FolderOpen,
  Clock,
  Layers,
  ArrowRight,
  Loader2,
} from 'lucide-react';

const SAMPLE_DOCS: Omit<DocumentItem, 'id'>[] = [
  {
    title: '桃太郎 (Momotaro - The Peach Boy)',
    rawType: 'paste',
    languageId: 'ja',
    createdAt: Date.now() - 1000 * 60 * 60 * 24,
    updatedAt: Date.now() - 1000 * 60 * 60 * 24,
    content: `昔々、ある所におじいさんとおばあさんが住んでいました。
おじいさんは山へ芝刈りに、おばあさんは川へ洗濯に行きました。
おばあさんが川で洗濯をしていると、川上から大きな桃が流れてきました。
「まあ、これは大きな桃だこと。家に持って帰ろう。」
おばあさんは桃を家に持ち帰り、おじいさんと一緒に切ろうとしました。
すると、桃がぱかっと割れて、中から元気な男の子が飛び出しました。
「おぎゃあ、おぎゃあ！」
二人はとても喜び、桃から生まれたので「桃太郎」と名付けました。
桃太郎はご飯をたくさん食べて、ぐんぐん大きくなりました。
そして強い男の子に成長しました。
ある日、桃太郎は言いました。
「鬼ヶ島へ行って、悪い鬼たちを退治してきます。」
おばあさんは美味しいきび団子を作ってあげました。
桃太郎はきび団子を腰につけて、鬼ヶ島へ旅立ちました。
道中、犬に出会いました。「桃太郎さん、どこへ行くのですか。」
「鬼ヶ島へ鬼退治に行くんだ。」
「腰につけたきび団子を一つくださいな。お供します。」
犬はきび団子をもらい、仲間になりました。
こうして桃太郎は犬、猿、キジを仲間にして、鬼ヶ島へ向かいました。
鬼たちと勇敢に戦い、見事に宝物を取り返して、平和に暮らしました。`,
  },
  {
    title: '日常会話：東京のカフェにて (At the Tokyo Cafe)',
    rawType: 'paste',
    languageId: 'ja',
    createdAt: Date.now() - 1000 * 60 * 60 * 12,
    updatedAt: Date.now() - 1000 * 60 * 60 * 12,
    content: `店員：「いらっしゃいませ！店内でお召し上がりですか。」
田中：「はい、店内でお願いします。」
店員：「ご注文はお決まりですか。」
田中：「温かいコーヒーを一つと、この抹茶ケーキをお願いします。」
店員：「かしこまりました。お会計は七百五十円になります。」
田中：「交通系ICカードで支払えますか。」
店員：「はい、ご利用いただけます。こちらの端末にタッチしてください。」
田中：「ピッ。ありがとうございます。」
店員：「ご注文の品は、こちらの番号札を持ってお席でお待ちください。」
田中：「天気が良くて、窓側の席はとても気持ちがいいですね。日本語の勉強をしながらゆっくり過ごそうと思います。」`,
  },
  {
    title: '日本の四季と自然 (Four Seasons and Nature in Japan)',
    rawType: 'paste',
    languageId: 'ja',
    createdAt: Date.now() - 1000 * 60 * 60 * 4,
    updatedAt: Date.now() - 1000 * 60 * 60 * 4,
    content: `日本には豊かな四季があります。
春には桜の花が咲き誇り、多くの人々が公園でお花見を楽しみます。
新しい生活や学校が始まる季節でもあります。
夏になると、気温が高くなり、緑が深く輝きます。夜には各地で花火大会やお祭りが開催されます。
秋は涼しく過ごしやすい季節です。山々の木々が赤や黄色に染まり、美しい紅葉が見られます。
また、美味しい食べ物がたくさん収穫されるため、「食欲の秋」とも呼ばれます。
冬には冷たい風が吹き、雪が降る地域もあります。温かい温泉に入ったり、鍋料理を食べたりして体を温めます。
自然の移り変わりを感じながら生活することは、日本の伝統的な文化の大切な一部です。`,
  },
];

export const LibraryView: React.FC = () => {
  const navigate = useNavigate();
  const { activeLanguageId, setActiveDocument } = useAppStore();
  const pack = getLanguagePack(activeLanguageId);

  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoading, setIsLoading] = useState(true);

  // Upload & Paste Modal
  const [showAddModal, setShowAddModal] = useState(false);
  const [modalMode, setModalMode] = useState<'paste' | 'upload'>('paste');
  const [pasteTitle, setPasteTitle] = useState('');
  const [pasteContent, setPasteContent] = useState('');
  const [isProcessingFile, setIsProcessingFile] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Load documents
  const loadDocuments = async () => {
    setIsLoading(true);
    try {
      let docs = await db.documents.where('languageId').equals(activeLanguageId).reverse().toArray();
      // If first time and no docs, seed sample documents
      if (docs.length === 0 && activeLanguageId === 'ja') {
        for (const item of SAMPLE_DOCS) {
          await db.documents.add(item);
        }
        docs = await db.documents.where('languageId').equals(activeLanguageId).reverse().toArray();
      }
      setDocuments(docs);
      setIsLoading(false);
    } catch (err) {
      console.error('Failed to load documents:', err);
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadDocuments();
  }, [activeLanguageId]);

  const handleOpenDoc = (doc: DocumentItem) => {
    setActiveDocument(doc);
    navigate('/reader');
  };

  const handleDeleteDoc = async (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm('Delete this text from your library?')) {
      await db.documents.delete(id);
      await logEvent('document_deleted', { docId: id });
      await loadDocuments();
    }
  };

  const handleSavePaste = async () => {
    if (!pasteContent.trim()) return;
    const title = pasteTitle.trim() || `Pasted Text - ${new Date().toLocaleDateString()}`;
    const newDoc: DocumentItem = {
      title,
      content: pasteContent.trim(),
      rawType: 'paste',
      languageId: activeLanguageId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const id = await db.documents.add(newDoc);
    await logEvent('document_created', { type: 'paste', title });
    newDoc.id = id;

    setShowAddModal(false);
    setPasteTitle('');
    setPasteContent('');
    setActiveDocument(newDoc);
    navigate('/reader');
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsProcessingFile(true);
    setUploadError(null);

    try {
      const parsed = await parseUploadedFile(file);
      const newDoc: DocumentItem = {
        title: parsed.title,
        content: parsed.content,
        rawType: parsed.rawType,
        languageId: activeLanguageId,
        chapters: parsed.chapters,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const id = await db.documents.add(newDoc);
      await logEvent('document_uploaded', { filename: file.name, type: parsed.rawType });
      newDoc.id = id;

      setIsProcessingFile(false);
      setShowAddModal(false);
      setActiveDocument(newDoc);
      navigate('/reader');
    } catch (err: any) {
      console.error('File parsing failed:', err);
      setIsProcessingFile(false);
      setUploadError(`Failed to parse file: ${err?.message || 'Unsupported format'}`);
    }
  };

  const filteredDocs = documents.filter((d) =>
    d.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
    d.content.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 flex flex-col pb-24 md:pb-12">
      {/* Top Header */}
      <header className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 px-4 py-6">
        <div className="max-w-5xl mx-auto flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xl">{pack.flagEmoji}</span>
              <h1 className="text-2xl font-black tracking-tight">{pack.name} Library</h1>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
              Offline reading materials stored locally in your browser
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setModalMode('paste');
                setShowAddModal(true);
              }}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold shadow-md shadow-indigo-600/20 transition active:scale-95"
            >
              <Plus className="w-4 h-4" />
              Add Text
            </button>
            <button
              onClick={() => {
                setModalMode('upload');
                setShowAddModal(true);
              }}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-800 dark:text-slate-200 text-xs font-semibold transition"
            >
              <Upload className="w-4 h-4" />
              Upload File
            </button>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="max-w-5xl w-full mx-auto p-4 sm:p-6 space-y-6 flex-1">
        {/* Search bar */}
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            placeholder="Search documents by title or text..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 transition"
          />
        </div>

        {/* Documents Grid */}
        {isLoading ? (
          <div className="py-20 flex flex-col items-center justify-center space-y-3">
            <Loader2 className="w-8 h-8 text-indigo-600 animate-spin" />
            <p className="text-xs text-slate-500 font-medium">Loading local library...</p>
          </div>
        ) : filteredDocs.length === 0 ? (
          <div className="py-16 text-center space-y-4 rounded-3xl border border-dashed border-slate-300 dark:border-slate-800 p-8">
            <div className="p-4 bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 dark:text-indigo-400 rounded-2xl w-fit mx-auto">
              <FolderOpen className="w-8 h-8" />
            </div>
            <div className="space-y-1">
              <h3 className="font-bold text-base">No documents found</h3>
              <p className="text-xs text-slate-500 max-w-sm mx-auto">
                Paste an article, upload a Japanese text/epub/subtitle file, or click below to restore sample materials.
              </p>
            </div>
            <button
              onClick={async () => {
                for (const item of SAMPLE_DOCS) {
                  await db.documents.add(item);
                }
                await loadDocuments();
              }}
              className="px-4 py-2 bg-indigo-600 text-white text-xs font-bold rounded-xl hover:bg-indigo-700 transition"
            >
              Load Sample Japanese Stories
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredDocs.map((doc) => {
              const preview = doc.content.slice(0, 120).replace(/\n+/g, ' ');

              return (
                <div
                  key={doc.id}
                  onClick={() => handleOpenDoc(doc)}
                  className="group p-5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-indigo-500/50 dark:hover:border-indigo-500/50 hover:shadow-lg transition-all duration-200 cursor-pointer flex flex-col justify-between"
                >
                  <div className="space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-md bg-indigo-50 text-indigo-700 dark:bg-indigo-950/70 dark:text-indigo-300">
                        {doc.rawType}
                      </span>
                      <button
                        onClick={(e) => handleDeleteDoc(doc.id!, e)}
                        title="Delete Document"
                        className="p-1 rounded-md text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-slate-800 transition"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>

                    <h3 className="font-bold text-base text-slate-900 dark:text-white group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition line-clamp-2">
                      {doc.title}
                    </h3>

                    <p className="text-xs text-slate-500 dark:text-slate-400 line-clamp-3 leading-relaxed">
                      {preview}...
                    </p>
                  </div>

                  <div className="pt-4 mt-4 border-t border-slate-100 dark:border-slate-800/80 flex items-center justify-between text-[11px] text-slate-400">
                    <div className="flex items-center gap-1.5">
                      <Clock className="w-3.5 h-3.5" />
                      <span>{new Date(doc.createdAt).toLocaleDateString()}</span>
                    </div>

                    <div className="flex items-center gap-1 text-indigo-600 dark:text-indigo-400 font-semibold group-hover:translate-x-1 transition-transform">
                      <span>Read</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>

      {/* Add Document Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl overflow-hidden p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <BookOpen className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
                <h3 className="font-bold text-base">Add Text to {pack.name} Library</h3>
              </div>
              <button
                onClick={() => setShowAddModal(false)}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-600"
              >
                ✕
              </button>
            </div>

            {/* Mode switch */}
            <div className="flex rounded-xl bg-slate-100 dark:bg-slate-800 p-1 text-xs font-semibold">
              <button
                onClick={() => setModalMode('paste')}
                className={`flex-1 py-1.5 rounded-lg transition ${
                  modalMode === 'paste' ? 'bg-white dark:bg-slate-900 text-indigo-600 shadow-sm' : 'text-slate-500'
                }`}
              >
                Paste Text
              </button>
              <button
                onClick={() => setModalMode('upload')}
                className={`flex-1 py-1.5 rounded-lg transition ${
                  modalMode === 'upload' ? 'bg-white dark:bg-slate-900 text-indigo-600 shadow-sm' : 'text-slate-500'
                }`}
              >
                Upload File (.txt, .epub, .srt, .vtt, .pdf)
              </button>
            </div>

            {modalMode === 'paste' ? (
              <div className="space-y-3">
                <div>
                  <label className="text-xs font-semibold text-slate-600 dark:text-slate-400 block mb-1">
                    Document Title (Optional)
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. Japanese news article, dialogue, blog post..."
                    value={pasteTitle}
                    onChange={(e) => setPasteTitle(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-600 dark:text-slate-400 block mb-1">
                    Japanese Content
                  </label>
                  <textarea
                    rows={8}
                    placeholder="Paste or type Japanese text here..."
                    value={pasteContent}
                    onChange={(e) => setPasteContent(e.target.value)}
                    className="w-full p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 font-sans"
                  />
                </div>

                <div className="flex justify-end gap-2 pt-2">
                  <button
                    onClick={() => setShowAddModal(false)}
                    className="px-4 py-2 text-xs font-semibold rounded-xl text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSavePaste}
                    disabled={!pasteContent.trim()}
                    className="px-5 py-2 text-xs font-bold rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white shadow-md shadow-indigo-600/20 transition"
                  >
                    Save & Open in Reader
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-4 py-4">
                <div className="border-2 border-dashed border-slate-300 dark:border-slate-700 rounded-2xl p-8 text-center space-y-3 hover:border-indigo-500 transition">
                  <Upload className="w-10 h-10 text-indigo-500 mx-auto" />
                  <div>
                    <p className="text-sm font-bold text-slate-900 dark:text-white">Choose a file to parse</p>
                    <p className="text-xs text-slate-500 mt-0.5">Supports .txt, .epub books, .srt & .vtt subtitles, and .pdf</p>
                  </div>

                  <label className="inline-block px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold rounded-xl cursor-pointer transition shadow-sm">
                    {isProcessingFile ? 'Parsing file...' : 'Browse Local Files'}
                    <input
                      type="file"
                      accept=".txt,.epub,.srt,.vtt,.pdf"
                      onChange={handleFileUpload}
                      disabled={isProcessingFile}
                      className="hidden"
                    />
                  </label>
                </div>

                {isProcessingFile && (
                  <div className="flex items-center justify-center gap-2 text-xs text-indigo-600 dark:text-indigo-400 font-semibold">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Extracting chapters and text...</span>
                  </div>
                )}

                {uploadError && (
                  <div className="p-3 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 rounded-xl text-xs text-rose-700 dark:text-rose-300">
                    {uploadError}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
