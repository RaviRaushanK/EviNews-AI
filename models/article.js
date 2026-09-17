module.exports = (sequelize, DataTypes) => {
  const crypto = require('crypto');

  const Article = sequelize.define('Article', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
      comment: 'Unique identifier for the article'
    },
    source_id: {
      type: DataTypes.UUID,
      allowNull: false,
      comment: 'Foreign key to sources.id'
    },
    title: {
      type: DataTypes.TEXT,
      allowNull: false,
      comment: 'Article headline'
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'Short summary or lead paragraph'
    },
    content: {
      type: DataTypes.TEXT('long'),
      allowNull: true,
      comment: 'Full article body (nullable — some sources provide only snippets)'
    },
    url: {
      type: DataTypes.TEXT,
      allowNull: false,
      comment: 'Canonical URL of the article (full text preserved; uniqueness enforced through url_hash)'
    },
    url_hash: {
      type: DataTypes.CHAR(64),
      allowNull: false,
      unique: true,
      comment: 'SHA-256 of normalized URL used for MySQL-safe duplicate protection'
    },
    author: {
      type: DataTypes.STRING(255),
      allowNull: true,
      comment: 'Author name(s)'
    },
    published_at: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: 'When the article was originally published'
    },
    fetched_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
      comment: 'When the article was fetched by our system'
    },
    image_url: {
      type: DataTypes.STRING(1024),
      allowNull: true,
      comment: 'URL to a representative image'
    },
    content_hash: {
      type: DataTypes.STRING(64),
      allowNull: false,
      unique: true,
      comment: 'SHA-256 hash of normalized article content for duplicate detection'
    },
    processing_status: {
      type: DataTypes.ENUM(
        'collected',
        'cleaned',
        'embedded',
        'clustered',
        'claims_extracted',
        'processed',
        'failed'
      ),
      allowNull: false,
      defaultValue: 'collected',
      comment: 'Current stage of the processing pipeline'
    },
    processing_error: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'Error message if processing failed'
    }
  }, {
    tableName: 'articles',
    timestamps: true,
    underscored: false,
    comment: 'Collected news articles from various sources',
    hooks: {
      beforeValidate: (instance) => {
        if (instance.url && !instance.url_hash) {
          const normalized = instance.url.trim();
          instance.url_hash = crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
        }
      }
    },
    indexes: [
      {
        name: 'idx_articles_url_hash',
        fields: ['url_hash'],
        unique: true
      },
      {
        name: 'idx_articles_source_published',
        fields: ['source_id', { attribute: 'published_at', order: 'DESC' }]
      },
      {
        name: 'idx_articles_processing_status',
        fields: ['processing_status', { attribute: 'fetched_at', order: 'DESC' }]
      },
      {
        name: 'idx_articles_published_at',
        fields: ['published_at']
      },
      {
        name: 'idx_articles_source_id',
        fields: ['source_id']
      },
      {
        name: 'idx_articles_fetched_at',
        fields: ['fetched_at']
      }
    ]
  });

  Article.associate = (models) => {
    Article.belongsTo(models.Source, {
      foreignKey: 'source_id',
      onDelete: 'RESTRICT',
      hooks: true
    });
    Article.hasMany(models.Claim, {
      foreignKey: 'article_id',
      onDelete: 'RESTRICT',
      hooks: true
    });
    Article.hasMany(models.ClaimEvidence, {
      foreignKey: 'article_id',
      onDelete: 'RESTRICT',
      hooks: true
    });
    Article.belongsToMany(models.Event, {
      through: models.EventArticle,
      foreignKey: 'article_id',
      otherKey: 'event_id'
    });
    Article.hasMany(models.TimelineEvent, {
      foreignKey: 'article_id',
      onDelete: 'SET NULL',
      hooks: true
    });
    Article.hasOne(models.ArticleEmbedding, {
      foreignKey: 'article_id',
      onDelete: 'CASCADE',
      hooks: true
    });
  };

  return Article;
};