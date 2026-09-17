'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('article_embeddings', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
        comment: 'Unique identifier for the article embedding'
      },
      article_id: {
        type: Sequelize.UUID,
        allowNull: false,
        unique: true,
        references: {
          model: 'articles',
          key: 'id'
        },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
        comment: 'Foreign key to articles.id (one embedding per article)'
      },
      model: {
        type: Sequelize.STRING(100),
        allowNull: false,
        comment: 'Embedding model name, e.g. gemini-embedding-001'
      },
      dimensions: {
        type: Sequelize.INTEGER,
        allowNull: false,
        comment: 'Vector dimensionality, e.g. 768'
      },
      content_hash: {
        type: Sequelize.CHAR(64),
        allowNull: false,
        comment: 'Copy of articles.content_hash at embed time; used to skip re-embedding unchanged articles'
      },
      vector: {
        type: Sequelize.JSON,
        allowNull: false,
        comment: 'Embedding vector as a JSON array of floats'
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP')
      }
    });

    await queryInterface.addIndex('article_embeddings', {
      name: 'idx_article_embeddings_article_id',
      fields: ['article_id'],
      unique: true
    });

    await queryInterface.addIndex('article_embeddings', {
      name: 'idx_article_embeddings_model',
      fields: ['model']
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('article_embeddings');
  }
};
