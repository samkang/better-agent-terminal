import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { logger } from './logger'

// Snippet interface
export type SnippetFormat = 'plaintext' | 'markdown'
export type SnippetAction = 'clipboard' | 'terminal' | 'agent' | 'edit'

export interface Snippet {
    id: number
    title: string
    content: string
    format: SnippetFormat
    action: SnippetAction   // what double-click does for this snippet
    category?: string
    tags?: string
    workspaceId?: string  // if set, only visible in this workspace
    isFavorite: boolean
    createdAt: number
    updatedAt: number
}

export interface CreateSnippetInput {
    title: string
    content: string
    format?: SnippetFormat
    action?: SnippetAction
    category?: string
    tags?: string
    workspaceId?: string
    isFavorite?: boolean
}

interface SnippetData {
    snippets: Snippet[]
    nextId: number
}

class SnippetDatabase {
    private readonly dataPath: string
    private data: SnippetData = { snippets: [], nextId: 1 }

    constructor() {
        const userDataPath = app.getPath('userData')
        this.dataPath = path.join(userDataPath, 'snippets.json')
        this.load()
    }

    private lastMtime = 0

    private load() {
        try {
            if (fs.existsSync(this.dataPath)) {
                const raw = fs.readFileSync(this.dataPath, 'utf-8')
                this.data = JSON.parse(raw)
                this.lastMtime = fs.statSync(this.dataPath).mtimeMs
                // Migrate: backfill action field for old snippets
                let migrated = false
                for (const s of this.data.snippets) {
                    if (!s.action) {
                        s.action = 'terminal'
                        migrated = true
                    }
                }
                if (migrated) this.save()
            }
        } catch (error) {
            logger.error('Failed to load snippets:', error)
            this.data = { snippets: [], nextId: 1 }
        }
    }

    private refreshIfChanged() {
        try {
            if (!fs.existsSync(this.dataPath)) return
            const mtime = fs.statSync(this.dataPath).mtimeMs
            if (mtime > this.lastMtime) this.load()
        } catch { /* ignore */ }
    }

    private save() {
        try {
            const dir = path.dirname(this.dataPath)
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true })
            }
            fs.writeFileSync(this.dataPath, JSON.stringify(this.data, null, 2), 'utf-8')
        } catch (error) {
            logger.error('Failed to save snippets:', error)
        }
    }

    create(input: CreateSnippetInput): Snippet {
        this.refreshIfChanged()
        const now = Date.now()
        const snippet: Snippet = {
            id: this.data.nextId++,
            title: input.title,
            content: input.content,
            format: input.format || 'plaintext',
            action: input.action || 'terminal',
            category: input.category,
            tags: input.tags,
            workspaceId: input.workspaceId,
            isFavorite: input.isFavorite || false,
            createdAt: now,
            updatedAt: now
        }
        this.data.snippets.push(snippet)
        this.save()
        return snippet
    }

    getById(id: number): Snippet | null {
        this.refreshIfChanged()
        return this.data.snippets.find(s => s.id === id) || null
    }

    getAll(): Snippet[] {
        this.refreshIfChanged()
        return [...this.data.snippets].sort((a, b) => b.updatedAt - a.updatedAt)
    }

    getFavorites(): Snippet[] {
        this.refreshIfChanged()
        return this.data.snippets
            .filter(s => s.isFavorite)
            .sort((a, b) => b.updatedAt - a.updatedAt)
    }

    getByCategory(category: string): Snippet[] {
        this.refreshIfChanged()
        return this.data.snippets
            .filter(s => s.category === category)
            .sort((a, b) => b.updatedAt - a.updatedAt)
    }

    search(query: string): Snippet[] {
        this.refreshIfChanged()
        const term = query.toLowerCase()
        return this.data.snippets
            .filter(s =>
                s.title.toLowerCase().includes(term) ||
                s.content.toLowerCase().includes(term) ||
                (s.tags && s.tags.toLowerCase().includes(term))
            )
            .sort((a, b) => b.updatedAt - a.updatedAt)
    }

    update(id: number, updates: Partial<CreateSnippetInput>): Snippet | null {
        this.refreshIfChanged()
        const index = this.data.snippets.findIndex(s => s.id === id)
        if (index === -1) return null

        const existing = this.data.snippets[index]
        const updated: Snippet = {
            ...existing,
            title: updates.title ?? existing.title,
            content: updates.content ?? existing.content,
            format: updates.format ?? existing.format,
            action: updates.action ?? existing.action,
            category: updates.category ?? existing.category,
            tags: updates.tags ?? existing.tags,
            workspaceId: updates.workspaceId !== undefined ? updates.workspaceId : existing.workspaceId,
            isFavorite: updates.isFavorite ?? existing.isFavorite,
            updatedAt: Date.now()
        }
        this.data.snippets[index] = updated
        this.save()
        return updated
    }

    delete(id: number): boolean {
        this.refreshIfChanged()
        const index = this.data.snippets.findIndex(s => s.id === id)
        if (index === -1) return false
        this.data.snippets.splice(index, 1)
        this.save()
        return true
    }

    toggleFavorite(id: number): Snippet | null {
        const snippet = this.getById(id)
        if (!snippet) return null
        return this.update(id, { isFavorite: !snippet.isFavorite })
    }

    getByWorkspace(workspaceId?: string): Snippet[] {
        this.refreshIfChanged()
        return this.data.snippets
            .filter(s => !s.workspaceId || s.workspaceId === workspaceId)
            .sort((a, b) => b.updatedAt - a.updatedAt)
    }

    getCategories(): string[] {
        this.refreshIfChanged()
        const categories = new Set<string>()
        for (const s of this.data.snippets) {
            if (s.category) categories.add(s.category)
        }
        return Array.from(categories).sort()
    }

    close() {
        // No-op for JSON storage
    }
}

export const snippetDb = new SnippetDatabase()
