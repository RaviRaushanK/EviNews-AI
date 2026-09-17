module.exports = (sequelize, DataTypes) => {
  const ArticleEmbedding = sequelize.define('ArticleEmbedding', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
      comment: 'Unique identifier for the article embedding'
    },
    article_id: {
      type: DataTypes.UUID,
      allowNull: false,
      unique: true,
      comment: 'Foreign key to articles.id (one embedding per article)'
    },
    model: {
      type: DataTypes.STRING(100),
      allowNull: false,
      comment: 'Embedding model name, e.g. gemini-embedding-001'
    },
    dimensions: {
      type: DataTypes.INTEGER,
      allowNull: false,
      comment: 'Vector dimensionality, e.g. 768'
    },
    content_hash: {
      type: DataTypes.CHAR(64),
      allowNull: false,
      comment: 'Copy of articles.content_hash at embed time; used to skip re-embedding unchanged articles'
    },
    vector: {
      type: DataTypes.JSON,
      allowNull: false,
      comment: 'Embedding vector as a JSON array of floats'
    }
  }, {
    tableName: 'article_embeddings',
    timestamps: true,
    underscored: false,
    comment: 'Regenerable embedding cache for article clustering',
    indexes: [
      {
        name: 'idx_article_embeddings_article_id',
        fields: ['article_id'],
        unique: true
      },
      {
        name: 'idx_article_embeddings_model',
        fields: ['model']
      }
    ]
  });

  ArticleEmbedding.associate = (models) => {
    ArticleEmbedding.belongsTo(models.Article, {
      foreignKey: 'article_id',
      onDelete: 'CASCADE',
      hooks: true
    });
  };

  return ArticleEmbedding;
};
